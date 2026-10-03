import { grainAt, GRAIN_SLOPE, lensAt, lensGeometry, liquidFront, liquidGeometry, liquidSettle, morphAt, progressAt, type GraphicsLayer, type ShaderTransition } from "@vs/domain";

/**
 * Shader transitions in the composition. The real scenes are masked and moved here, one exact
 * value per output frame (GSAP sets, like counting numbers, so preview and export agree and
 * nothing is tweened between frames): a vector clip for the liquid front and the lens, SVG
 * filters for the pixel work (liquid displacement, noise dissolve, colour fringing) and plain
 * transforms for magnifying and morphing. The light on top (meniscus, lens rim, grain, morph fill)
 * is a Skia shader overlay drawn from the same motion functions (domain transitionMotion.ts).
 */
export interface ShaderTransitionInput {
  type: ShaderTransition;
  /** Element ids of the incoming and outgoing scene clips. */
  sid: string;
  prevSid: string;
  sceneId: string;
  /** Output frame the transition starts on, and its length in frames. */
  startFrame: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  unit: number;
  seed: number;
  /** Brand colours (hex) for the light: primary, secondary, accent. */
  colors: string[];
}

export interface ShaderTransitionOutput {
  /** SVG filter definitions (inside an invisible <svg>). */
  defs: string;
  tweens: string[];
  /** The Skia overlay drawn above both scenes for the transition. */
  overlay: GraphicsLayer;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Sets land a quarter frame early so float rounding can never hold a frame back. */
const at = (frame: number, fps: number) => Math.round(((frame - 0.25) / fps) * 10000) / 10000;

const SPLIT = (id: string) => `<feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="r"/>
<feOffset id="${id}-r" in="r" dx="0" dy="0" result="r2"/>
<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="g"/>
<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="b"/>
<feOffset id="${id}-b" in="b" dx="0" dy="0" result="b2"/>
<feBlend in="r2" in2="g" mode="screen" result="rg"/>
<feBlend in="rg" in2="b2" mode="screen" result="sp"/>`;

export function shaderTransition(i: ShaderTransitionInput): ShaderTransitionOutput {
  const { sid, prevSid, startFrame, frames, fps, width: W, height: H, unit } = i;
  const tweens: string[] = [];
  const set = (sel: string, props: string, frame: number) => tweens.push(`tl.set(${JSON.stringify(sel)},{${props}},${at(startFrame + frame, fps)});`);
  const fid = `fx-${i.sceneId}`;
  const params: GraphicsLayer["params"] = { frames, fps, colors: i.colors.join(",") };
  let defs = "";
  const reset: string[] = [];

  if (i.type === "liquid") {
    const g = liquidGeometry(i.seed, W, H, unit);
    Object.assign(params, { amp: r3(g.amp), tilt: r3(g.tilt), k1: g.k[0], k2: g.k[1], k3: g.k[2], ph1: g.ph[0], ph2: g.ph[1], ph3: g.ph[2], margin: r3(g.margin) });
    defs = `<filter id="${fid}" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="${r3(0.0045 / unit)}" numOctaves="2" seed="${i.seed % 997}" result="n"/><feDisplacementMap id="${fid}-d" in="SourceGraphic" in2="n" scale="0" xChannelSelector="R" yChannelSelector="G"/></filter>`;
    for (let f = 0; f < frames; f++) {
      const p = progressAt(f, frames);
      const settle = liquidSettle(p);
      // Overscale covers the displaced edges: it grows with the wobble and is gone when it settles.
      const s = 1 + 0.05 * settle;
      const local = (x: number, y: number) => `${r1(W / 2 + (x - W / 2) / s)}px ${r1(H / 2 + (y - H / 2) / s)}px`;
      const pts: string[] = [local(-4, -4)];
      const N = 40;
      for (let k = 0; k <= N; k++) {
        const y = -4 + ((H + 8) * k) / N;
        pts.push(local(liquidFront(g, p, y), y));
      }
      pts.push(local(-4, H + 4));
      set(`#${sid}`, `clipPath:"polygon(${pts.join(",")})",filter:"url(#${fid})",scale:${r3(s)},transformOrigin:"50% 50%"`, f);
      set(`#${fid}-d`, `attr:{scale:${r1(g.wobble * settle)}}`, f);
    }
    reset.push(`tl.set(${JSON.stringify(`#${sid}`)},{clipPath:"none",filter:"none",scale:1},${at(startFrame + frames, fps)});`);
  } else if (i.type === "lens") {
    const g = lensGeometry(i.seed, W, H, unit);
    Object.assign(params, { fromX: r3(g.from[0]), fromY: r3(g.from[1]), rMax: r3(g.rMax) });
    for (let f = 0; f < frames; f++) {
      const p = progressAt(f, frames);
      const l = lensAt(g, p);
      // The next scene is magnified around the lens centre; its clip is in its own (unscaled) space.
      set(`#${sid}`, `clipPath:"circle(${r1(l.r / l.mag)}px at ${r1(l.cx)}px ${r1(l.cy)}px)",scale:${r3(l.mag)},transformOrigin:"${r1(l.cx)}px ${r1(l.cy)}px"`, f);
      set(`#${prevSid}`, `scale:${r3(1 + 0.06 * p)},transformOrigin:"50% 50%"`, f);
    }
    reset.push(`tl.set(${JSON.stringify(`#${sid}`)},{clipPath:"none",scale:1,transformOrigin:"50% 50%"},${at(startFrame + frames, fps)});`);
    reset.push(`tl.set(${JSON.stringify(`#${prevSid}`)},{scale:1},${at(startFrame + frames, fps)});`);
  } else if (i.type === "grain") {
    defs =
      `<filter id="${fid}-in" color-interpolation-filters="sRGB">${SPLIT(`${fid}-in`)}<feTurbulence type="fractalNoise" baseFrequency="${r3(0.004 / unit)}" numOctaves="4" seed="${i.seed % 997}" result="n"/><feColorMatrix id="${fid}-m" in="n" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${GRAIN_SLOPE} 0 0 0 ${-GRAIN_SLOPE}" result="m"/><feComposite in="sp" in2="m" operator="in"/></filter>` +
      `<filter id="${fid}-out" color-interpolation-filters="sRGB">${SPLIT(`${fid}-out`)}</filter>`;
    for (let f = 0; f < frames; f++) {
      const p = progressAt(f, frames);
      const g = grainAt(p, unit);
      // Overscale so the shifted colour channels never leave a bare edge.
      const cover = r3(1 + (2.4 * g.fringe) / Math.min(W, H));
      set(`#${sid}`, `filter:"url(#${fid}-in)",scale:${cover},transformOrigin:"50% 50%"`, f);
      set(`#${prevSid}`, `filter:"url(#${fid}-out)",scale:${cover},transformOrigin:"50% 50%"`, f);
      for (const side of ["in", "out"]) {
        set(`#${fid}-${side}-r`, `attr:{dx:${r1(-g.fringe)}}`, f);
        set(`#${fid}-${side}-b`, `attr:{dx:${r1(g.fringe)}}`, f);
      }
      set(`#${fid}-m`, `attr:{values:"0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${GRAIN_SLOPE} 0 0 0 ${r3(-GRAIN_SLOPE * g.threshold)}"}`, f);
    }
    reset.push(`tl.set(${JSON.stringify(`#${sid},#${prevSid}`)},{filter:"none",scale:1},${at(startFrame + frames, fps)});`);
  } else {
    // morph: the overlay covers everything outside the shape; the scenes shrink and grow inside it.
    for (let f = 0; f < frames; f++) {
      const p = progressAt(f, frames);
      const m = morphAt(W, H, unit, p);
      if (m.phase === 0) {
        set(`#${prevSid}`, `scale:${r3(m.sceneScale)},opacity:1,transformOrigin:"50% 50%"`, f);
        set(`#${sid}`, `opacity:0`, f);
      } else {
        set(`#${prevSid}`, `opacity:0`, f);
        set(`#${sid}`, `scale:${r3(m.sceneScale)},opacity:1,transformOrigin:"50% 50%"`, f);
      }
    }
    reset.push(`tl.set(${JSON.stringify(`#${sid},#${prevSid}`)},{scale:1,opacity:1},${at(startFrame + frames, fps)});`);
  }

  return {
    defs,
    tweens: [...tweens, ...reset],
    overlay: { id: `tr${i.sceneId}`, kind: "graphics", slot: "decor", backend: "skia", component: `tr-${i.type}`, componentVersion: 1, params, seed: i.seed, hidden: false },
  };
}
