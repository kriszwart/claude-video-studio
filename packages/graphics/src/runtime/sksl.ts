/**
 * Skia shader effects (SkSL runtime effects). Each effect is a fragment program plus a pure
 * function from (parameters, seed, time, size) to its uniforms, so every frame is an exact
 * function of time. The runtime draws them on a shared WebGL surface (see skia-runtime.ts):
 * on the CPU raster surface a full-frame shader costs seconds per frame.
 *
 * Shader output is premultiplied: transparent effects return half4(rgb * a, a).
 */

import { grainAt, lensAt, liquidX, morphAt, type LensGeometry, type LiquidGeometry } from "@vs/domain/transitionMotion";

export interface ShaderInput {
  params: Record<string, number | string | boolean>;
  seed: number;
  /** Seconds since the layer started, and the layer's length. */
  t: number;
  dur: number;
  /** Layer size in pixels, and pixels per 1080p pixel. */
  w: number;
  h: number;
  unit: number;
}

export interface ShaderEffect {
  sksl: string;
  /** Uniform values by name; arrays and vectors are flat number lists. */
  uniforms: (i: ShaderInput) => Record<string, number | number[]>;
  /** Image parameters bound to child shaders, in declaration order (cover-fit to the layer). */
  images?: string[];
  /** True when the effect fills its whole box (a background); false for an object over the scene. */
  opaque: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers (pure JS)

export function rgb(hex: string): [number, number, number] {
  const v = /^#?([0-9a-f]{6})$/i.exec(hex.trim())?.[1] ?? "ffffff";
  return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
}

/** Up to four colours from a comma list (repeating the last to fill), as a flat float3[4]. */
export function palette(list: unknown, fallback = "#8b5cf6,#ec4899,#fb7a5a,#38bdf8"): number[] {
  const cols = String(list || fallback)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^#?[0-9a-f]{6}$/i.test(s));
  const use = (cols.length ? cols : fallback.split(",")).slice(0, 4);
  while (use.length < 4) use.push(use[use.length - 1]!);
  return use.flatMap((c) => rgb(c));
}

/** Seeded, deterministic random numbers (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity) => {
  const n = Number(v);
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : d));
};
const smooth = (x: number) => x * x * (3 - 2 * x);

/** Shape sequence timeline: which two shapes are showing and how far the change has gone. */
export const SHAPES = ["circle", "squircle", "star", "heart", "triangle", "ring", "blob"] as const;
export function shapeAt(seq: number[], hold: number, morph: number, t: number): { a: number; b: number; k: number } {
  if (seq.length < 2) return { a: seq[0] ?? 0, b: seq[0] ?? 0, k: 0 };
  const cycle = hold + morph;
  const i = Math.floor(t / cycle);
  const local = t - i * cycle;
  const a = seq[i % seq.length]!;
  const b = seq[(i + 1) % seq.length]!;
  return { a, b, k: local <= hold ? 0 : smooth(Math.min(1, (local - hold) / morph)) };
}

// SkSL snippets ---------------------------------------------------------------

const NOISE = `
float hash(float2 p){ return fract(sin(dot(p, float2(127.1, 311.7))) * 43758.5453); }
float noise(float2 p){ float2 i = floor(p); float2 f = fract(p); float2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+float2(1,0)), u.x), mix(hash(i+float2(0,1)), hash(i+float2(1,1)), u.x), u.y); }
float fbm(float2 p){ float v = 0.0; float a = 0.5; for (int i = 0; i < 5; i++){ v += a*noise(p); p = p*2.03 + float2(17.0, 9.0); a *= 0.5; } return v; }
float fbm3(float2 p){ float v = 0.0; float a = 0.5; for (int i = 0; i < 3; i++){ v += a*noise(p); p = p*1.97 + float2(17.0, 9.0); a *= 0.5; } return v / 0.875; }
`;
/** Four-colour ramp, u in [0, 1] (wraps smoothly back to the first colour). */
const RAMP = `
half3 ramp(float u){ u = fract(u) * 4.0; float k = fract(u); float s = k*k*(3.0-2.0*k);
  if (u < 1.0) return half3(mix(c0, c1, s)); if (u < 2.0) return half3(mix(c1, c2, s)); if (u < 3.0) return half3(mix(c2, c3, s)); return half3(mix(c3, c0, s)); }
`;
/** A fixed, per-pixel dither (no flicker: it doesn't change over time) against gradient banding. */
const DITHER = `float dither(float2 p){ return (fract(sin(dot(floor(p), float2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0; }`;

// ---------------------------------------------------------------------------
// Effects

/** mesh-gradient v1: four colours on slow, seeded orbits, blended by distance with a soft warp. */
const meshGradient: ShaderEffect = {
  opaque: true,
  sksl: `
uniform float2 res; uniform float t; uniform float softness; uniform float warp;
uniform float3 c0; uniform float3 c1; uniform float3 c2; uniform float3 c3;
uniform float4 orbit[4];
${NOISE}
${DITHER}
half4 main(float2 p){
  float2 uv = p / res; float aspect = res.x / res.y; uv.x *= aspect;
  uv += warp * 0.12 * float2(noise(uv*2.5 + t*0.15) - 0.5, noise(uv*2.5 + 7.0 - t*0.12) - 0.5);
  float3 col = float3(0); float wsum = 0;
  for (int i = 0; i < 4; i++){
    float4 o = orbit[i];
    float2 c = float2((0.5 + 0.38*sin(t*o.z + o.x)) * aspect, 0.5 + 0.38*cos(t*o.w + o.y));
    float d = length(uv - c);
    float w = 1.0 / pow(d*d + 0.02, softness);
    float3 ci = i == 0 ? c0 : i == 1 ? c1 : i == 2 ? c2 : c3;
    col += ci * w; wsum += w;
  }
  col /= wsum;
  return half4(half3(col + dither(p)), 1);
}`,
  uniforms: ({ params, seed, t, w, h }) => {
    const r = rng(seed);
    const speed = num(params.speed, 0.25, 0, 3);
    const orbit: number[] = [];
    for (let i = 0; i < 4; i++) orbit.push(r() * 6.283, r() * 6.283, (0.6 + r() * 0.8) * speed, (0.5 + r() * 0.9) * speed);
    const cols = palette(params.colors);
    return { res: [w, h], t, softness: num(params.softness, 1.6, 0.5, 4), warp: num(params.warp, 0.4, 0, 1), c0: cols.slice(0, 3), c1: cols.slice(3, 6), c2: cols.slice(6, 9), c3: cols.slice(9, 12), orbit };
  },
};

/** aurora v1: domain-warped noise folded into silky bands of the palette over a dark base. */
const aurora: ShaderEffect = {
  opaque: true,
  sksl: `
uniform float2 res; uniform float t; uniform float scale; uniform float intensity; uniform float2 offset;
uniform float3 base; uniform float3 c0; uniform float3 c1; uniform float3 c2; uniform float3 c3;
${NOISE}
${RAMP}
${DITHER}
half4 main(float2 p){
  float2 uv = p / res.y * scale + offset;
  uv.y *= 1.6; // stretch: long, sweeping folds rather than cells
  float2 q = float2(fbm3(uv + float2(0.0, t*0.04)), fbm3(uv + float2(5.2, 1.3) - t*0.035));
  float f = fbm3(uv + 1.4*q + float2(t*0.03, 0.0));
  // Bands of light where the field crosses a few levels: thin, bright, softly falling off.
  float bands = 0.0;
  for (int i = 0; i < 3; i++){ float lv = 0.38 + 0.12*float(i); bands += exp(-pow((f - lv) * 14.0, 2.0)) * (0.6 + 0.4*q.x); }
  half3 c = ramp(f*0.8 + q.y*0.5 + t*0.015);
  float glow = smoothstep(0.2, 0.75, f);
  float3 col = base + float3(c) * (0.35*glow + 0.85*bands) * intensity;
  return half4(half3(col + dither(p)), 1);
}`,
  uniforms: ({ params, seed, t, w, h }) => {
    const r = rng(seed);
    const cols = palette(params.colors);
    return { res: [w, h], t: t * num(params.speed, 1, 0, 4), scale: num(params.scale, 1.6, 0.5, 8), intensity: num(params.intensity, 1, 0, 2), offset: [r() * 50, r() * 50], base: rgb(String(params.base ?? "#0b0a14")), c0: cols.slice(0, 3), c1: cols.slice(3, 6), c2: cols.slice(6, 9), c3: cols.slice(9, 12) };
  },
};

/** metaballs v1: glossy blobs on seeded orbits; the field's gradient gives them a lit, 3D surface. */
const metaballs: ShaderEffect = {
  opaque: false,
  sksl: `
uniform float2 res; uniform float count; uniform float gloss; uniform float px;
uniform float4 balls[8]; // xy centre (pixels), z radius (pixels), w colour index
uniform float3 c0; uniform float3 c1; uniform float3 c2; uniform float3 c3;
half4 main(float2 p){
  float f = 0; float2 g = float2(0); float3 col = float3(0); float wsum = 0;
  for (int i = 0; i < 8; i++){
    if (float(i) >= count) break;
    float4 b = balls[i];
    float2 d = p - b.xy; float d2 = dot(d, d) + 1.0;
    float fi = b.z*b.z / d2;
    f += fi; g += -2.0 * b.z*b.z * d / (d2*d2);
    float ci = b.w;
    float3 cc = ci < 0.5 ? c0 : ci < 1.5 ? c1 : ci < 2.5 ? c2 : c3;
    col += cc * fi*fi; wsum += fi*fi;
  }
  col /= max(wsum, 1e-5);
  // Signed distance estimate to the f = 1 surface, for a clean, antialiased edge.
  float gl = max(length(g), 1e-5);
  float sd = (1.0 - f) / gl;
  float a = clamp(0.5 - sd / px, 0.0, 1.0);
  if (a <= 0.0) return half4(0);
  // Height grows toward the inside; the normal leans along the field gradient near the edge.
  float hgt = clamp((f - 1.0) * 0.9, 0.0, 1.0);
  float3 n = normalize(float3(-g / gl * (1.0 - hgt), 0.55 + hgt));
  float3 L = normalize(float3(-0.45, -0.6, 0.65));
  float diff = clamp(dot(n, L), 0.0, 1.0);
  float spec = pow(clamp(dot(reflect(-L, n), float3(0, 0, 1)), 0.0, 1.0), 36.0) * gloss;
  float rim = pow(1.0 - n.z, 2.0) * 0.35;
  float3 c = col * (0.45 + 0.65*diff) + spec + rim * col;
  return half4(half3(c) * half(a), half(a));
}`,
  uniforms: ({ params, seed, t, w, h }) => {
    const r = rng(seed);
    const n = Math.round(num(params.count, 6, 1, 8));
    const speed = num(params.speed, 0.5, 0, 3);
    const m = Math.min(w, h);
    const fill = num(params.fill, 0.7, 0.2, 1.2);
    const balls: number[] = [];
    for (let i = 0; i < 8; i++) {
      const ph = r() * 6.283, fx = 0.4 + r() * 0.9, fy = 0.4 + r() * 0.9, amp = 0.18 + r() * 0.2, rad = (0.08 + r() * 0.07) * fill;
      const x = w / 2 + Math.sin(t * speed * fx + ph) * amp * w * fill;
      const y = h / 2 + Math.cos(t * speed * fy + ph * 1.3) * amp * h * fill;
      balls.push(x, y, rad * m, i % 4);
    }
    const cols = palette(params.colors);
    return { res: [w, h], count: n, gloss: num(params.gloss, 0.8, 0, 2), px: 1.2, balls, c0: cols.slice(0, 3), c1: cols.slice(3, 6), c2: cols.slice(6, 9), c3: cols.slice(9, 12) };
  },
};

/** liquid-morph v1: a glossy liquid shape that melts from one form into the next. */
const liquidMorph: ShaderEffect = {
  opaque: false,
  sksl: `
uniform float2 res; uniform float t; uniform float shapeA; uniform float shapeB; uniform float k;
uniform float size; uniform float wobble; uniform float gloss; uniform float glow; uniform float px;
uniform float3 c0; uniform float3 c1; uniform float3 c2; uniform float3 c3;
${RAMP}
float sdBox(float2 p, float2 b, float r){ float2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float sdTri(float2 p, float r){ const float k3 = 1.7320508; p.x = abs(p.x) - r; p.y = p.y + r/k3;
  if (p.x + k3*p.y > 0.0) p = float2(p.x - k3*p.y, -k3*p.x - p.y) / 2.0; p.x -= clamp(p.x, -2.0*r, 0.0); return -length(p) * sign(p.y); }
float sdStar(float2 p, float r, float rf){ const float2 k1 = float2(0.809016994375, -0.587785252292); const float2 k2 = float2(-k1.x, k1.y);
  p.x = abs(p.x); p -= 2.0*max(dot(k1, p), 0.0)*k1; p -= 2.0*max(dot(k2, p), 0.0)*k2; p.x = abs(p.x); p.y -= r;
  float2 ba = rf*float2(-k1.y, k1.x) - float2(0, 1); float h = clamp(dot(p, ba)/dot(ba, ba), 0.0, r);
  return length(p - ba*h) * sign(p.y*ba.x - p.x*ba.y); }
float sdHeart(float2 p){ p.x = abs(p.x); p.y = -p.y + 0.55;
  if (p.y + p.x > 1.0) return sqrt(dot(p - float2(0.25, 0.75), p - float2(0.25, 0.75))) - 0.3535534;
  float a = dot(p - float2(0.0, 1.0), p - float2(0.0, 1.0)); float2 m = p - 0.5*max(p.x + p.y, 0.0); return sqrt(min(a, dot(m, m))) * sign(p.x - p.y); }
float shape(float id, float2 p){
  if (id < 0.5) return length(p) - 0.62;
  if (id < 1.5) return sdBox(p, float2(0.56), 0.22);
  if (id < 2.5) return sdStar(p * 1.05, 0.72, 0.5) - 0.04;
  if (id < 3.5) return sdHeart(p * 0.95) * 1.05;
  if (id < 4.5) return sdTri(p * float2(1.0, -1.0) + float2(0, -0.08), 0.62) - 0.08;
  if (id < 5.5) return abs(length(p) - 0.5) - 0.16;
  float a = atan(p.y, p.x); return length(p) - (0.55 + 0.07*sin(3.0*a + 1.3) + 0.05*sin(5.0*a - 0.7));
}
float field(float2 p){
  float d = mix(shape(shapeA, p), shape(shapeB, p), k);
  // The melt: ripples that swell mid-change and settle when the shape holds.
  float m = sin(3.14159 * k);
  float a = atan(p.y, p.x);
  return d + wobble * (0.025 + 0.05*m) * sin(6.0*a + t*2.2) * smoothstep(0.9, 0.2, abs(d));
}
half4 main(float2 fragCoord){
  float s = min(res.x, res.y) * 0.5 * size;
  float2 p = (fragCoord - res*0.5) / s;
  float d = field(p);
  float e = px / s;
  float2 g = float2(field(p + float2(e, 0)) - field(p - float2(e, 0)), field(p + float2(0, e)) - field(p - float2(0, e)));
  float2 n2 = normalize(g + 1e-6);
  float aa = clamp(0.5 - d / e, 0.0, 1.0);
  float halo = glow * exp(-max(d, 0.0) * 9.0) * 0.55 * (1.0 - aa);
  // Colour flows diagonally across the shape (no angle term: atan would leave a seam at ±π).
  half3 base = ramp(0.12*t + 0.22*(p.x - p.y) + 0.18*length(p) + 0.08*sin(2.0*p.y + t));
  if (aa <= 0.0) return half4(base * half(halo), half(halo));
  float hgt = clamp(-d * 5.0, 0.0, 1.0);
  float3 n = normalize(float3(n2 * (1.0 - hgt), 0.5 + hgt));
  float3 L = normalize(float3(-0.5, -0.65, 0.6));
  float diff = clamp(dot(n, L), 0.0, 1.0);
  float spec = pow(clamp(dot(reflect(-L, n), float3(0, 0, 1)), 0.0, 1.0), 48.0) * gloss;
  float fres = pow(1.0 - n.z, 3.0);
  float3 c = float3(base) * (0.42 + 0.7*diff) + spec + fres * 0.45;
  float a = aa + halo;
  return half4(half3(c * aa + float3(base) * halo), half(min(a, 1.0)));
}`,
  uniforms: ({ params, t, w, h }) => {
    const seq = String(params.sequence ?? "circle,squircle,star,heart")
      .split(",")
      .map((s) => SHAPES.indexOf(s.trim().toLowerCase() as (typeof SHAPES)[number]))
      .filter((i) => i >= 0);
    const m = shapeAt(seq.length ? seq : [0, 1], num(params.holdSec, 1.2, 0.1, 10), num(params.morphSec, 1, 0.1, 10), t);
    const cols = palette(params.colors);
    return { res: [w, h], t, shapeA: m.a, shapeB: m.b, k: m.k, size: num(params.fill, 0.62, 0.2, 1.2), wobble: num(params.wobble, 1, 0, 3), gloss: num(params.gloss, 0.9, 0, 2), glow: params.glow === false ? 0 : 1, px: 1.2, c0: cols.slice(0, 3), c1: cols.slice(3, 6), c2: cols.slice(6, 9), c3: cols.slice(9, 12) };
  },
};

/** glass-lens v1: a refracting, magnifying lens that glides over the owner's image. */
const glassLens: ShaderEffect = {
  opaque: true,
  images: ["image"],
  sksl: `
uniform shader image;
uniform float2 res; uniform float2 c; uniform float r; uniform float mag; uniform float refr; uniform float chroma; uniform float px;
half4 main(float2 p){
  float2 d = p - c; float dist = length(d);
  half4 bg = image.eval(p);
  if (dist > r + px * 30.0) return bg;
  // Soft contact shadow just outside the rim.
  if (dist > r) { float sh = smoothstep(r + px*30.0, r, dist) * 0.28; return half4(bg.rgb * half(1.0 - sh), bg.a); }
  // A spherical cap: the normal tilts toward the rim, bending the view (refraction) and magnifying.
  float u = dist / r; float z = sqrt(max(1.0 - u*u, 0.0));
  float2 bend = d / r * (1.0 - z) * refr * r * 0.6;
  float2 q = c + d / mag - bend;
  float2 ca = d / max(dist, 1e-3) * chroma * px * 3.0 * u;
  half3 col = half3(image.eval(q + ca).r, image.eval(q).g, image.eval(q - ca).b);
  // Glass: a cool tint toward the rim, a sharp highlight and a bright edge.
  float3 n = normalize(float3(d / r, z + 0.25));
  float3 L = normalize(float3(-0.45, -0.6, 0.66));
  float spec = pow(clamp(dot(reflect(-L, n), float3(0, 0, 1)), 0.0, 1.0), 40.0);
  float edge = smoothstep(0.86, 1.0, u);
  float3 g = float3(col) * (1.0 - 0.12*edge) + float3(0.85, 0.92, 1.0) * (0.35*edge + 0.6*spec);
  float aa = clamp((r - dist) / px + 0.5, 0.0, 1.0);
  return half4(mix(bg.rgb, half3(g), half(aa)), 1);
}`,
  uniforms: ({ params, t, dur, w, h }) => {
    const m = Math.min(w, h);
    const r = num(params.lensSize, 0.26, 0.05, 0.6) * m;
    const path = String(params.path ?? "drift");
    const u = dur > 0 ? Math.min(1, t / dur) : 0;
    const e = smooth(u);
    let x = w / 2, y = h / 2;
    if (path === "sweep") {
      x = r + (w - 2 * r) * e;
      y = h / 2 + Math.sin(e * Math.PI) * h * -0.12;
    } else if (path === "drift") {
      x = w / 2 + Math.sin(t * 0.55) * (w / 2 - r) * 0.7;
      y = h / 2 + Math.sin(t * 0.37 + 1) * (h / 2 - r) * 0.55;
    } else {
      // "focus": settle on the close-up point.
      const fx = num(params.focalX, 0.5, 0, 1), fy = num(params.focalY, 0.5, 0, 1);
      x = w / 2 + (fx * w - w / 2) * e;
      y = h / 2 + (fy * h - h / 2) * e;
    }
    return { res: [w, h], c: [x, y], r, mag: num(params.magnify, 1.6, 1, 4), refr: num(params.refraction, 0.5, 0, 1.5), chroma: num(params.chroma, 0.35, 0, 3), px: 1 };
  },
};


// ---------------------------------------------------------------------------
// Transition overlays. The compositor masks and moves the real scenes; these draw the light on
// top of them, from the same motion functions (domain transitionMotion.ts) so both line up.
// Progress is snapped to the transition's own frames, so mask and light agree on every frame.

const trProgress = (params: ShaderInput["params"], t: number) => {
  const frames = num(params.frames, 12, 1, 600);
  return Math.min(1, Math.max(0, Math.round(t * num(params.fps, 30, 1, 240)) / frames));
};

/** tr-liquid v1: a glossy meniscus along the liquid front, with a soft shadow ahead of it. */
const trLiquid: ShaderEffect = {
  opaque: false,
  sksl: `
uniform float2 res; uniform float X; uniform float amp; uniform float tilt; uniform float3 k; uniform float3 ph;
uniform float p; uniform float unit; uniform float3 c0; uniform float3 c1; uniform float3 c2; uniform float3 c3;
${RAMP}
float front(float y){ float v = y / res.y * 6.283185;
  return X + amp * (0.55*sin(k.x*v + ph.x + 4.0*p) + 0.3*sin(k.y*v + ph.y - 6.0*p) + 0.15*sin(k.z*v + ph.z + 9.0*p)) + tilt * (y / res.y - 0.5); }
half4 main(float2 q){
  float d = q.x - front(q.y);
  float b = 34.0 * unit;
  float s = d / b;
  // Slope of the front here: the highlight catches where the surface turns toward the light.
  float slope = (front(q.y + 2.0) - front(q.y - 2.0)) / 4.0;
  float band = smoothstep(-0.45, -0.2, s) * (1.0 - smoothstep(0.65, 1.0, s));
  float3 col = float3(ramp(q.y / res.y * 0.6 + p * 0.5)) * (0.72 + 0.28 * (1.0 - clamp(s, 0.0, 1.0)));
  float spec = exp(-pow((s - 0.12) / 0.09, 2.0)) * (0.55 + 0.45 * clamp(0.5 - slope, 0.0, 1.0));
  col = mix(col, float3(1.0), clamp(spec * 0.85, 0.0, 1.0));
  float shadow = d > 0.0 ? 0.3 * (1.0 - smoothstep(b * 0.6, b + 70.0 * unit, d)) : 0.0;
  float a = band + shadow * (1.0 - band);
  return half4(half3(col * band), half(a));
}`,
  uniforms: ({ params, t, w, h, unit }) => {
    const g: LiquidGeometry = { W: w, H: h, amp: num(params.amp, 0), tilt: num(params.tilt, 0), k: [num(params.k1, 1), num(params.k2, 2), num(params.k3, 4)], ph: [num(params.ph1, 0), num(params.ph2, 0), num(params.ph3, 0)], margin: num(params.margin, 0), wobble: 0 };
    const p = trProgress(params, t);
    const cols = palette(params.colors);
    return { res: [w, h], X: liquidX(g, p), amp: g.amp, tilt: g.tilt, k: g.k, ph: g.ph, p, unit, c0: cols.slice(0, 3), c1: cols.slice(3, 6), c2: cols.slice(6, 9), c3: cols.slice(9, 12) };
  },
};

/** tr-lens v1: the lens's rim: a shadow outside, Fresnel darkening, colour fringes and a highlight. */
const trLens: ShaderEffect = {
  opaque: false,
  sksl: `
uniform float2 res; uniform float2 c; uniform float r; uniform float rim; uniform float unit; uniform float fade;
half4 main(float2 q){
  float2 v = q - c; float d = length(v); float2 n = d > 0.0 ? v / d : float2(0.0, -1.0);
  float shadow = d > r ? 0.32 * (1.0 - smoothstep(r, r + 56.0 * unit, d)) : 0.0;
  float x = (r - d) / rim;
  float inside = step(0.0, x);
  float dark = inside * 0.38 * (1.0 - smoothstep(0.0, 1.0, x));
  float3 fringe = inside * float3(exp(-pow((x - 0.1) / 0.08, 2.0)), 0.6 * exp(-pow((x - 0.28) / 0.1, 2.0)), exp(-pow((x - 0.5) / 0.13, 2.0))) * 0.55;
  float spec = inside * pow(max(0.0, dot(n, normalize(float2(-0.6, -0.8)))), 6.0) * exp(-pow((x - 0.22) / 0.16, 2.0));
  float3 light = fringe + float3(spec * 0.95);
  float a = clamp(max(dark, shadow) + max(light.r, max(light.g, light.b)) * 0.9, 0.0, 1.0);
  return half4(half3(min(light, float3(a))) * half(fade), half(a * fade));
}`,
  uniforms: ({ params, t, w, h, unit }) => {
    const g: LensGeometry = { W: w, H: h, from: [num(params.fromX, w / 2), num(params.fromY, h / 2)], to: [w / 2, h / 2], rMax: num(params.rMax, Math.hypot(w, h) / 2), unit };
    const p = trProgress(params, t);
    const l = lensAt(g, p);
    return { res: [w, h], c: [l.cx, l.cy], r: l.r, rim: Math.max(10 * unit, l.r * 0.09), unit, fade: 1 - smoothstep01((p - 0.7) / 0.25) };
  },
};

/** tr-grain v1: moving film grain and a brand-coloured light leak at the dissolve's peak. */
const trGrain: ShaderEffect = {
  opaque: false,
  sksl: `
uniform float2 res; uniform float frame; uniform float unit; uniform float leak; uniform float grain;
uniform float2 l0; uniform float2 l1; uniform float3 c0; uniform float3 c1;
float hash(float2 p){ return fract(sin(dot(p, float2(127.1, 311.7))) * 43758.5453); }
half4 main(float2 q){
  float n = hash(floor(q / (1.6 * unit)) + float2(frame * 17.0, frame * 31.0)) - 0.5;
  float ga = abs(n) * 2.0 * grain;
  float3 gc = n > 0.0 ? float3(1.0) : float3(0.0);
  float s = 0.5 * min(res.x, res.y);
  // Light leaks are long, soft streaks of light: stretched along x.
  float2 d0 = (q - l0) * float2(0.45, 1.0); float2 d1 = (q - l1) * float2(0.5, 1.0);
  float g0 = exp(-dot(d0, d0) / (s * s)); float g1 = exp(-dot(d1, d1) / (s * s * 1.4));
  float la = clamp((g0 + g1) * leak * 0.42, 0.0, 0.6);
  float3 lc = (c0 * g0 + c1 * g1) / max(g0 + g1, 1e-4);
  // Leak over grain (premultiplied).
  float a = la + ga * (1.0 - la);
  float3 col = lc * la + gc * ga * (1.0 - la);
  return half4(half3(col), half(a));
}`,
  uniforms: ({ params, seed, t, w, h, unit }) => {
    const p = trProgress(params, t);
    const g = grainAt(p, unit);
    const r = rng(seed * 31 + 5);
    const a0 = r() * 6.283;
    const cols = palette(params.colors);
    const e = p;
    return {
      res: [w, h],
      frame: Math.round(t * num(params.fps, 30, 1, 240)),
      unit,
      leak: g.leak,
      grain: 0.07 + 0.15 * Math.sin(Math.PI * p),
      l0: [w * (0.15 + 0.7 * e), h * (0.5 + 0.35 * Math.sin(a0))],
      l1: [w * (0.85 - 0.6 * e), h * (0.5 + 0.35 * Math.cos(a0))],
      c0: cols.slice(0, 3),
      c1: cols.slice(3, 6),
    };
  },
};

/** tr-morph v1: brand colour flowing outside a morphing shape, with a lit rim around it. */
const trMorph: ShaderEffect = {
  opaque: false,
  sksl: `
uniform float2 res; uniform float t; uniform float p; uniform float size; uniform float2 shape; uniform float k; uniform float rot; uniform float unit;
uniform float3 c0; uniform float3 c1; uniform float3 c2; uniform float3 c3;
${NOISE}
${RAMP}
float rad(float id, float a){
  if (id < 0.5) return pow(pow(abs(cos(a)), 4.0) + pow(abs(sin(a)), 4.0), -0.25);
  if (id < 1.5) return 0.78 + 0.22 * cos(5.0 * a);
  return 1.0;
}
half4 main(float2 q){
  float2 v = q - res * 0.5;
  float a = atan(v.y, v.x) - rot;
  float edge = size * mix(rad(shape.x, a), rad(shape.y, a), k);
  float d = length(v) - edge;
  float outside = smoothstep(-0.75, 0.75, d);
  float2 uv = q / min(res.x, res.y);
  // A slow, smooth flow of the brand colours (low frequency: colour fields, not noise).
  float flow = fbm3(uv * 0.7 + float2(t * 0.35, -t * 0.25));
  float3 fill = float3(ramp(flow * 0.8 + (uv.x + uv.y) * 0.18 + p * 0.3));
  fill *= 0.9 + 0.2 * smoothstep(0.3, 0.8, fbm3(uv * 1.3 - float2(t * 0.2, 0.0)));
  float lip = exp(-pow((d - 5.0 * unit) / (5.0 * unit), 2.0));
  fill = mix(fill, float3(1.0), lip * 0.35);
  float glow = exp(-pow((d + 7.0 * unit) / (6.0 * unit), 2.0)) * (1.0 - outside);
  float alpha = outside + glow * 0.55;
  float3 col = fill * outside + float3(1.0) * glow * 0.55;
  return half4(half3(col), half(clamp(alpha, 0.0, 1.0)));
}`,
  uniforms: ({ params, t, w, h, unit }) => {
    const p = trProgress(params, t);
    const m = morphAt(w, h, unit, p);
    const cols = palette(params.colors);
    return { res: [w, h], t, p, size: m.size, shape: [m.a, m.b], k: m.k, rot: m.rot, unit, c0: cols.slice(0, 3), c1: cols.slice(3, 6), c2: cols.slice(6, 9), c3: cols.slice(9, 12) };
  },
};

const smoothstep01 = (x: number) => smooth(Math.min(1, Math.max(0, x)));

export const SHADER_EFFECTS: Record<string, ShaderEffect> = {
  "mesh-gradient@1": meshGradient,
  "aurora@1": aurora,
  "metaballs@1": metaballs,
  "liquid-morph@1": liquidMorph,
  "glass-lens@1": glassLens,
  "tr-liquid@1": trLiquid,
  "tr-lens@1": trLens,
  "tr-grain@1": trGrain,
  "tr-morph@1": trMorph,
};
