/**
 * Shader transitions: the motion they share between the compositor (which moves and masks the real
 * scenes, frame by frame) and the Skia overlay (which draws the light on top: a liquid meniscus, a
 * lens rim, grain, a morphing shape). Both read these functions, so the mask and the light line up
 * to the pixel. Pure and dependency-free: the Skia runtime bundles this file for the browser.
 *
 *  - liquid: the next scene floods in behind a wavy, glossy front, settling from a liquid wobble;
 *  - lens:   a glass lens drifts in, magnifying the next scene, and grows to fill the frame;
 *  - grain:  a grainy noise dissolve with colour fringing and a light leak at its peak;
 *  - morph:  the scene shrinks into a shape that morphs, and the next grows out of it.
 */

export const SHADER_TRANSITIONS = ["liquid", "lens", "grain", "morph"] as const;
export type ShaderTransition = (typeof SHADER_TRANSITIONS)[number];
export const isShaderTransition = (type: string): type is ShaderTransition => (SHADER_TRANSITIONS as readonly string[]).includes(type);

/** Seeded, deterministic random numbers (mulberry32). */
function rand(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};
/** Cubic in-out: the shared pace of every shader transition. */
export const transitionEase = (x: number) => {
  const p = clamp01(x);
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
};

/** Progress at an output frame of a transition `frames` long (0 on its first frame). */
export const progressAt = (frame: number, frames: number) => clamp01(frame / Math.max(1, frames));

// --- liquid -------------------------------------------------------------------

export interface LiquidGeometry {
  W: number;
  H: number;
  amp: number;
  tilt: number;
  k: [number, number, number];
  ph: [number, number, number];
  /** How far beyond each edge the front starts and ends (so it begins and ends off screen). */
  margin: number;
  /** Peak displacement (px) of the next scene's liquid wobble, and its matching overscale. */
  wobble: number;
}

export function liquidGeometry(seed: number, W: number, H: number, unit: number): LiquidGeometry {
  const r = rand(seed * 7919 + 13);
  const amp = 0.045 * W;
  const tilt = 0.16 * W * (r() < 0.5 ? -1 : 1);
  const k: [number, number, number] = [1.1 + r() * 0.5, 2.4 + r() * 0.8, 4.6 + r() * 1.2];
  const ph: [number, number, number] = [r() * 6.283, r() * 6.283, r() * 6.283];
  return { W, H, amp, tilt, k, ph, margin: amp + Math.abs(tilt) / 2 + 8 * unit, wobble: 34 * unit };
}

/** Where the front's baseline is at progress p (a sine pace: it is on screen for most of the move). */
export const liquidX = (g: LiquidGeometry, p: number) => -g.margin + (g.W + 2 * g.margin) * (0.5 - 0.5 * Math.cos(Math.PI * clamp01(p)));

/** The front's x at height y: left of it shows the next scene. */
export function liquidFront(g: LiquidGeometry, p: number, y: number): number {
  const v = (y / g.H) * 6.283185;
  const wave = 0.55 * Math.sin(g.k[0] * v + g.ph[0] + 4 * p) + 0.3 * Math.sin(g.k[1] * v + g.ph[1] - 6 * p) + 0.15 * Math.sin(g.k[2] * v + g.ph[2] + 9 * p);
  return liquidX(g, p) + g.amp * wave + g.tilt * (y / g.H - 0.5);
}

/** How much liquid wobble is left in the next scene (1 → 0). */
export const liquidSettle = (p: number) => Math.pow(1 - transitionEase(p), 1.2);

// --- lens ---------------------------------------------------------------------

export interface LensGeometry {
  W: number;
  H: number;
  from: [number, number];
  to: [number, number];
  /** Radius that covers the frame from its centre. */
  rMax: number;
  unit: number;
}

export function lensGeometry(seed: number, W: number, H: number, unit: number): LensGeometry {
  const r = rand(seed * 104729 + 7);
  const side = r() < 0.5 ? 0.3 : 0.7;
  return { W, H, from: [W * (side + (r() - 0.5) * 0.08), H * (0.6 + r() * 0.08)], to: [W / 2, H / 2], rMax: 0.5 * Math.hypot(W, H) + 24 * unit, unit };
}

/** The lens at progress p: centre, radius and how much it magnifies the next scene. */
export function lensAt(g: LensGeometry, p: number): { cx: number; cy: number; r: number; mag: number } {
  const e = transitionEase(p);
  const r = g.rMax * (0.3 * smooth(p / 0.45) + 0.7 * smooth((p - 0.35) / 0.65));
  return { cx: g.from[0] + (g.to[0] - g.from[0]) * e, cy: g.from[1] + (g.to[1] - g.from[1]) * e, r, mag: 1 + 0.45 * (1 - smooth(p)) };
}

// --- grain ---------------------------------------------------------------------

/**
 * Grain dissolve at p: the noise threshold, colour fringe (px) and light-leak peak. Fractal noise
 * sits mostly between 0.25 and 0.75, so the threshold sweeps that band (0.78 → 0.08) for patches
 * that grow steadily across the whole transition.
 */
export function grainAt(p: number, unit: number): { threshold: number; fringe: number; leak: number } {
  return { threshold: 0.78 - 0.7 * smooth(p), fringe: 12 * unit * Math.sin(Math.PI * clamp01(p)), leak: Math.pow(Math.sin(Math.PI * clamp01(p)), 1.5) };
}
/** Slope of the dissolve: higher is a harder, grainier edge. */
export const GRAIN_SLOPE = 10;

// --- morph ---------------------------------------------------------------------

/** Shapes the morph passes through: squircle (the frame) → star (the turn) → circle (the next). */
export const MORPH_SHAPES = { squircle: 0, star: 1, circle: 2 } as const;

/** Radius of a shape at angle a, relative to its size (squircle 1–1.19, star 0.56–1, circle 1). */
export function morphShapeRadius(shape: number, a: number): number {
  if (shape === 0) return Math.pow(Math.pow(Math.abs(Math.cos(a)), 4) + Math.pow(Math.abs(Math.sin(a)), 4), -0.25);
  if (shape === 1) return 0.78 + 0.22 * Math.cos(5 * a);
  return 1;
}

export interface MorphState {
  /** 0: the outgoing scene is closing; 1: the next is opening. */
  phase: 0 | 1;
  /** Shape size (px; 0 at the swap) and its mix from shape a to shape b. */
  size: number;
  a: number;
  b: number;
  k: number;
  rot: number;
  /** Scale of the scene inside the shape. */
  sceneScale: number;
}

/** Size that covers the frame even at the star's narrowest point. */
export const morphCover = (W: number, H: number, unit: number) => (0.5 * Math.hypot(W, H)) / 0.56 + 20 * unit;

export function morphAt(W: number, H: number, unit: number, p: number): MorphState {
  const cover = morphCover(W, H, unit);
  const rot = 1.2 * transitionEase(p);
  // Closing accelerates into the swap and opening bursts out of it: momentum through the middle.
  if (p < 0.5) {
    const e = Math.pow(p / 0.5, 2.2);
    const size = cover * (1 - e);
    // The scene shrinks with the shape, but never inside it: it always fills whatever of the shape
    // is on screen (squircle and star reach at most 1.19 of the size), so no edge ever shows.
    const fills = Math.min(1, Math.max((1.2 * size) / (W / 2), (1.2 * size) / (H / 2)));
    return { phase: 0, size, a: MORPH_SHAPES.squircle, b: MORPH_SHAPES.star, k: e, rot, sceneScale: Math.max(1 - 0.3 * e, fills) };
  }
  const e = 1 - Math.pow(1 - (p - 0.5) / 0.5, 2.2);
  return { phase: 1, size: cover * e, a: MORPH_SHAPES.star, b: MORPH_SHAPES.circle, k: e, rot, sceneScale: 1.25 - 0.25 * e };
}
