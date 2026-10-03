/**
 * three.js (WebGL) graphics runtime, executed inside a compiled composition page.
 * Contract with the HyperFrames runtime (same as the Skia runtime):
 *  - setup is registered on window.__hf.buildReady (render waits for it);
 *  - every "hf-seek" renders each layer as a pure function of composition time, synchronously;
 *  - renderer size and pixel ratio are pinned, the drawing buffer is preserved for capture,
 *    there is no animation loop and no wall clock; randomness is seeded.
 */
import * as THREE from "three";
import { morphAt, SOLIDS, subdivide, type Solid } from "./polyhedra";

export interface ThreeLayerSpec {
  id: string;
  backend: "three";
  unit?: number;
  component: string;
  version: number;
  params: Record<string, number | string | boolean>;
  startSec: number;
  durationSec: number;
  width: number;
  height: number;
  seed: number;
}

interface Layer {
  spec: ThreeLayerSpec;
  make: (canvas: HTMLCanvasElement, spec: ThreeLayerSpec) => (t: number) => void;
  /** Set while the layer's scene is on screen; WebGL contexts are scarce (browsers keep ~16). */
  live: { draw: (t: number) => void; renderers: THREE.WebGLRenderer[] } | null;
  lastT: number | null;
}

/** Renderers created by the component being built, so its context can be released later. */
let building: THREE.WebGLRenderer[] = [];
function track(r: THREE.WebGLRenderer): THREE.WebGLRenderer {
  building.push(r);
  return r;
}

type W = typeof window & {
  __hf?: { buildReady?: Record<string, Promise<unknown>> };
  __vsGraphics?: { backend?: string }[];
  __vsThreeReport?: { layers: number; frames: number; errors: string[] };
};
const w = window as W;

/** Deterministic hash of a number to 0..1. */
const hash1 = (x: number) => {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const colorsOf = (v: unknown, fallback: string[]) => {
  const list = String(v ?? "").split(",").map((x) => x.trim()).filter((x) => /^#[0-9a-f]{6}$/i.test(x));
  return (list.length ? list : fallback).slice(0, 6).map((h) => new THREE.Color(h));
};

// 3D simplex noise (after Stefan Gustavson's public-domain description of the algorithm).
const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-0.5;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  vec3 ns=0.142857142857*vec3(2.0,0.5,1.0)-vec3(0.0,1.0,0.0);
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

// Shared surface: every point is a direction s on the unit sphere. The solid's own point in that
// direction comes from its radial function (all faces of a platonic solid share one inradius),
// blended to the sphere by uInflate, then rippled and twisted by uMutate. Normals are taken from
// the deformed surface itself (finite differences), so shading stays continuous while it melts.
const DEFORM = /* glsl */ `
uniform float uInflate; uniform float uMutate; uniform float uTime;
uniform vec3 uFaceN[20]; uniform int uFaceCount; uniform float uRin; uniform float uSpike;
attribute vec3 aSphere;
float polyR(vec3 s){
  float m = 1e-4;
  for (int i = 0; i < 20; i++) { if (i >= uFaceCount) break; m = max(m, dot(s, uFaceN[i])); }
  return uRin / m;
}
vec3 surf(vec3 s){
  vec3 q = mix(s * polyR(s), s, uInflate);
  vec3 np = s * 1.15 + vec3(0.0, uTime * 0.35, uTime * 0.18);
  float n = snoise(np) + 0.2 * snoise(np * 2.2 + 3.1);
  q *= 1.0 + n * 0.2 * uMutate;
  float a = uMutate * 0.8 * q.y;
  float c = cos(a), sn = sin(a);
  q.xz = mat2(c, -sn, sn, c) * q.xz;
  // Spikes: sharp crystal thorns out of the noise peaks (driven by the beat).
  float sp = pow(max(0.0, snoise(s * 3.6 + vec3(7.0, uTime * 0.2, 1.0))), 3.0);
  q *= 1.0 + uSpike * sp * 1.6;
  return q;
}
vec3 surfNormal(vec3 s, vec3 q){
  vec3 t1 = normalize(cross(s, abs(s.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(s, t1);
  const float e = 0.01;
  vec3 n = normalize(cross(surf(normalize(s + e * t1)) - q, surf(normalize(s + e * t2)) - q));
  return dot(n, q) < 0.0 ? -n : n;
}`;

const SOLID_VERT = /* glsl */ `
${NOISE}
${DEFORM}
attribute vec3 aFlat; attribute float aFace;
uniform float uSnap;
varying vec3 vN; varying vec3 vV; varying float vFace; varying vec3 vS;
void main(){
  vec3 q = surf(aSphere);
  // Vertex snap: low-resolution, wobbling geometry in glitch bursts.
  if (uSnap > 0.0) q = floor(q * uSnap + 0.5) / uSnap;
  // Held solids keep exact flat faces; once it starts to melt, the surface normal takes over.
  vec3 n = normalize(mix(aFlat, surfNormal(aSphere, q), smoothstep(0.0, 0.12, uInflate + uMutate)));
  vec4 mv = modelViewMatrix * vec4(q, 1.0);
  vN = normalize(normalMatrix * n); vV = -mv.xyz; vFace = aFace; vS = aSphere;
  gl_Position = projectionMatrix * mv;
}`;

const SOLID_FRAG = /* glsl */ `
uniform vec3 uPal[6]; uniform int uPalN; uniform float uProgress; uniform float uTime; uniform float uIrid; uniform int uMaterial;
varying vec3 vN; varying vec3 vV; varying float vFace; varying vec3 vS;
vec3 palette(float x){
  float n = float(uPalN);
  float p = fract(x) * n;
  int i = int(floor(p));
  vec3 a = uPal[0]; vec3 b = uPal[0];
  for (int k = 0; k < 6; k++) { if (k == i) a = uPal[k]; if (k == int(mod(float(i + 1), n))) b = uPal[k]; }
  return mix(a, b, smoothstep(0.0, 1.0, p - floor(p)));
}
void main(){
  vec3 N = normalize(vN); vec3 V = normalize(vV);
  vec3 L = normalize(vec3(-0.45, 0.62, 0.65));
  vec3 H = normalize(L + V);
  float diff = max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, H), 0.0), 48.0);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.4);
  vec3 base = palette(vFace * 0.6 + uProgress * 1.5);
  // Thin-film iridescence: hue shifts with viewing angle, like a soap bubble.
  vec3 irid = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + fres * 1.6 + dot(vS, vec3(0.4, 0.3, 0.2)) + uTime * 0.05));
  vec3 col = base * (0.28 + 0.86 * diff) + irid * fres * uIrid + vec3(1.0) * spec * 0.85 + base * fres * 0.5;
  if (uMaterial == 1) {
    // Chrome: a procedural studio environment reflected in the surface (bright horizon, ring
    // lights, a palette-tinted floor), so it reads as liquid metal without any texture.
    vec3 R = reflect(-V, N);
    float y = R.y;
    vec3 sky = mix(vec3(0.02), vec3(0.85, 0.88, 0.95), smoothstep(-0.05, 0.5, y));
    float horizon = exp(-pow(y * 9.0, 2.0)) * 1.6;
    float rings = smoothstep(0.92, 1.0, sin(y * 26.0 + R.x * 3.0 + uTime * 0.6)) * 0.9;
    vec3 floorC = base * 0.35 * smoothstep(0.0, -0.6, y);
    vec3 env = sky * 0.55 + vec3(horizon) + vec3(rings) + floorC;
    col = env * mix(vec3(1.0), base, 0.35) + irid * fres * 0.6 * uIrid + vec3(1.0) * pow(max(dot(N, H), 0.0), 160.0) * 1.5;
  } else if (uMaterial == 2) {
    // X-ray: dark body, glowing rim and iridescent edges only.
    col = base * pow(fres, 1.3) * 2.2 + irid * fres * uIrid * 0.8 + vec3(0.02);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const SHELL_FRAG = /* glsl */ `
uniform vec3 uGlow; uniform float uStrength;
varying vec3 vN; varying vec3 vV;
void main(){
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
  gl_FragColor = vec4(uGlow * f * uStrength, 0.0);
}`;

const EDGE_VERT = /* glsl */ `
${NOISE}
${DEFORM}
varying float vFront;
void main(){
  vec3 q = surf(aSphere) * 1.004;
  vec4 mv = modelViewMatrix * vec4(q, 1.0);
  vFront = (normalMatrix * normalize(q)).z;
  gl_Position = projectionMatrix * mv;
}`;
const EDGE_FRAG = /* glsl */ `
uniform vec3 uEdge; uniform float uAlpha; varying float vFront;
void main(){ gl_FragColor = vec4(uEdge * uAlpha * smoothstep(-0.15, 0.25, vFront), 0.0); }`;

/**
 * Pure light: adds colour and leaves the canvas alpha alone. The canvas is premultiplied, so the
 * page composites it as glow over whatever is behind the layer, never as a dark film.
 */
function lightMaterial(opts: { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string; side?: THREE.Side }) {
  return new THREE.ShaderMaterial({
    ...opts,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
}

function solidGeometry(solid: Solid, detail: number) {
  const tris = subdivide(solid, detail);
  const pos = new Float32Array(tris.length * 9), sph = new Float32Array(tris.length * 9), flat = new Float32Array(tris.length * 9), face = new Float32Array(tris.length * 3);
  const faceNormals = solid.faces.map((f) => {
    const c = f.reduce((a, i) => a.add(new THREE.Vector3(...solid.vertices[i]!)), new THREE.Vector3());
    return c.normalize();
  });
  tris.forEach((t, i) => {
    t.p.forEach((p, k) => {
      const o = i * 9 + k * 3;
      const s = new THREE.Vector3(...p).normalize();
      pos.set(p, o);
      sph.set([s.x, s.y, s.z], o);
      const fn = faceNormals[t.face]!;
      flat.set([fn.x, fn.y, fn.z], o);
      face[i * 3 + k] = t.face / solid.faces.length;
    });
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aSphere", new THREE.BufferAttribute(sph, 3));
  g.setAttribute("aFlat", new THREE.BufferAttribute(flat, 3));
  g.setAttribute("aFace", new THREE.BufferAttribute(face, 1));
  return g;
}

function edgeGeometry(solid: Solid) {
  const seg = 24;
  const pos: number[] = [], sph: number[] = [];
  for (const [a, b] of solid.edges) {
    const va = new THREE.Vector3(...solid.vertices[a]!), vb = new THREE.Vector3(...solid.vertices[b]!);
    for (let k = 0; k < seg; k++) {
      for (const u of [k / seg, (k + 1) / seg]) {
        const p = va.clone().lerp(vb, u);
        pos.push(p.x, p.y, p.z);
        const s = p.clone().normalize();
        sph.push(s.x, s.y, s.z);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aSphere", new THREE.Float32BufferAttribute(sph, 3));
  return g;
}

/**
 * platonic-shader v1: an iridescent, shader-lit platonic solid that mutates through a sequence.
 * Each solid inflates into a sphere, rippling and twisting with 3D noise on the way, and the next
 * solid grows out of that sphere. A fresnel glow shell, seeded particles and a floor shadow sit
 * around it. Everything is a function of t.
 */
function platonicShader(canvas: HTMLCanvasElement, spec: ThreeLayerSpec): (t: number) => void {
  const p = spec.params;
  const renderer = track(new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true }));
  renderer.setPixelRatio(1);
  renderer.setSize(spec.width, spec.height, false);
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const aspect = spec.width / spec.height;
  const fov = 30;
  const fill = Math.max(0.2, Math.min(1.2, Number(p.fill ?? 0.6)));
  const tanHalf = Math.tan(((fov / 2) * Math.PI) / 180);
  const dist = 1.15 / (fill * tanHalf * Math.min(1, aspect));
  const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 100);
  camera.position.set(0, 0.15, dist);
  camera.lookAt(0, 0, 0);

  const seq = String(p.sequence ?? "tetrahedron,cube,octahedron,dodecahedron,icosahedron").split(",").map((x) => x.trim().toLowerCase()).filter((x) => SOLIDS[x]);
  const hold = Math.max(0.2, Number(p.holdSec ?? 2));
  const morph = Math.max(0.2, Number(p.morphSec ?? 1.8));
  const detail = Math.max(2, Math.min(4, Math.round(Number(p.detail ?? 3))));
  const pal = colorsOf(p.colors, ["#8b5cf6", "#ec4899", "#fb7a5a", "#38bdf8"]);
  const palArr = Array.from({ length: 6 }, (_, i) => pal[i % pal.length]!);
  const uniforms = {
    uInflate: { value: 0 }, uMutate: { value: 0 }, uTime: { value: 0 }, uProgress: { value: 0 },
    uPal: { value: palArr }, uPalN: { value: pal.length }, uIrid: { value: Math.max(0, Math.min(2, Number(p.iridescence ?? 1))) },
    uFaceN: { value: Array.from({ length: 20 }, () => new THREE.Vector3()) }, uFaceCount: { value: 0 }, uRin: { value: 1 },
    uSpike: { value: 0 }, uSnap: { value: 0 }, uMaterial: { value: ({ iridescent: 0, chrome: 1, xray: 2 } as Record<string, number>)[String(p.material ?? "iridescent")] ?? 0 },
  };
  // Face normals and inradius of each solid, swapped into the shared uniforms for the one drawn.
  const shapes = seq.map((name) => {
    const s = SOLIDS[name]!;
    const centres = s.faces.map((f) => f.reduce((a, i) => a.add(new THREE.Vector3(...s.vertices[i]!)), new THREE.Vector3()).divideScalar(f.length));
    return { normals: centres.map((c) => c.clone().normalize()), rin: centres[0]!.length() };
  });
  const solidMat = new THREE.ShaderMaterial({ uniforms, vertexShader: SOLID_VERT, fragmentShader: SOLID_FRAG });
  const glow = new THREE.Color(pal[0]!);
  const shellUniforms = { ...uniforms, uGlow: { value: glow }, uStrength: { value: 0.9 } };
  const shellMat = lightMaterial({ uniforms: shellUniforms, vertexShader: SOLID_VERT, fragmentShader: SHELL_FRAG, side: THREE.BackSide });
  const edgeUniforms = { ...uniforms, uEdge: { value: new THREE.Color(String(p.edgeColor ?? "#f5f3ff")) }, uAlpha: { value: 1 } };
  const edgeMat = lightMaterial({ uniforms: edgeUniforms, vertexShader: EDGE_VERT, fragmentShader: EDGE_FRAG });

  const group = new THREE.Group();
  scene.add(group);
  const meshes = seq.map((name) => {
    const s = SOLIDS[name]!;
    const geo = solidGeometry(s, detail);
    const mesh = new THREE.Mesh(geo, solidMat);
    const shell = new THREE.Mesh(geo, shellMat);
    shell.scale.setScalar(1.16);
    const edges = new THREE.LineSegments(edgeGeometry(s), edgeMat);
    const holder = new THREE.Group();
    holder.add(shell, mesh, edges);
    holder.visible = false;
    group.add(holder);
    return holder;
  });

  // Seeded particles on a loose shell around the solid; they twinkle and drift with t.
  const r = rng(spec.seed || 1);
  const N = Math.max(0, Math.min(2000, Math.round(Number(p.particles ?? 420))));
  const ppos = new Float32Array(N * 3), pphase = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const u = r() * 2 - 1, th = r() * Math.PI * 2, rad = 1.55 + r() * 1.2;
    const s = Math.sqrt(1 - u * u);
    ppos.set([Math.cos(th) * s * rad, u * rad * 0.8, Math.sin(th) * s * rad], i * 3);
    pphase[i] = r() * 6.2831;
  }
  const pgeo = new THREE.BufferGeometry();
  pgeo.setAttribute("position", new THREE.BufferAttribute(ppos, 3));
  pgeo.setAttribute("aPhase", new THREE.BufferAttribute(pphase, 1));
  const unit = spec.unit ?? 1;
  const pmat = lightMaterial({
    uniforms: { uTime: uniforms.uTime, uColor: { value: new THREE.Color(pal[pal.length - 1]!) }, uSize: { value: 9 * unit } },
    vertexShader: /* glsl */ `uniform float uTime; uniform float uSize; attribute float aPhase; varying float vA;
      void main(){ float a = uTime * 0.08 + aPhase * 0.02; vec3 q = position; q.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * q.xz;
        vec4 mv = modelViewMatrix * vec4(q, 1.0); vA = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * 1.7 + aPhase));
        gl_PointSize = uSize * (6.0 / -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `uniform vec3 uColor; varying float vA;
      void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d) * vA; gl_FragColor = vec4(uColor * a, 0.0); }`,
  });
  const points = new THREE.Points(pgeo, pmat);
  scene.add(points);

  // Soft floor shadow under the solid.
  const shadowMat = new THREE.ShaderMaterial({
    uniforms: { uStrength: { value: 0.5 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `uniform float uStrength; varying vec2 vUv; void main(){ float d = length((vUv - 0.5) * vec2(1.0, 1.0)) * 2.0; float a = smoothstep(1.0, 0.0, d) * uStrength; gl_FragColor = vec4(0.0, 0.0, 0.0, a); }`,
    transparent: true, depthWrite: false,
  });
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -1.45;
  scene.add(shadow);

  const spin = Number(p.spin ?? 0.4);
  const mutation = Math.max(0, Math.min(2, Number(p.mutation ?? 1)));
  const showEdges = p.edges !== false;
  shadow.visible = p.shadow !== false;
  // A layer can be one window onto a longer piece: the morph timeline and the clock (spin, ripples,
  // particles, colour, beat) are shifted separately, so consecutive scenes continue one motion.
  const morphOffset = Number(p.morphOffsetSec ?? 0);
  const clockOffset = Number(p.clockOffsetSec ?? 0);
  const colorCycle = Math.max(0, Number(p.colorCycleSec ?? 0));
  const bpm = Math.max(0, Math.min(240, Number(p.bpm ?? 0)));
  const beatOffset = Number(p.beatOffsetSec ?? 0);
  const pulse = Math.max(0, Math.min(1, Number(p.pulse ?? 0.5)));
  const minInflate = Math.max(0, Math.min(1, Number(p.minInflate ?? 0)));
  const spikes = Math.max(0, Math.min(1, Number(p.spikes ?? 0)));
  const glitch = Math.max(0, Math.min(1, Number(p.glitch ?? 0)));
  return (t: number) => {
    const st = morphAt(t + morphOffset, seq.length, hold, morph);
    const c = t + clockOffset;
    meshes.forEach((m, i) => (m.visible = i === st.index));
    const shape = shapes[st.index]!;
    shape.normals.forEach((n, i) => uniforms.uFaceN.value[i]!.copy(n));
    uniforms.uFaceCount.value = shape.normals.length;
    uniforms.uRin.value = shape.rin;
    // minInflate holds the form partway (1 = a rippling sphere whatever the sequence says).
    const inflation = Math.max(st.inflation, minInflate);
    const wave = Math.sin(Math.PI * inflation);
    uniforms.uInflate.value = inflation;
    // Beat: a sharp hit that decays over the beat (0 when no tempo is set).
    const beatPhase = bpm > 0 ? (((c - beatOffset) * bpm) / 60) % 1 : 0;
    const hit = bpm > 0 && c >= beatOffset ? Math.exp(-7 * (beatPhase < 0 ? beatPhase + 1 : beatPhase)) * pulse : 0;
    // Ripples peak mid-melt and keep moving through the sphere (both solids meet there, so the
    // hand-off stays seamless); each beat kicks them a little.
    uniforms.uMutate.value = mutation * (0.6 * wave + 0.4 * inflation + 0.25 * hit);
    uniforms.uTime.value = c;
    const progress = colorCycle > 0 ? c / colorCycle : st.progress;
    uniforms.uProgress.value = progress;
    const gi = (((progress * 1.5 * pal.length) % pal.length) + pal.length) % pal.length;
    glow.copy(pal[Math.floor(gi)]!).lerp(pal[(Math.floor(gi) + 1) % pal.length]!, gi - Math.floor(gi));
    shellUniforms.uStrength.value = 0.9 + 1.1 * hit;
    uniforms.uSpike.value = spikes * hit;
    // Glitch bursts on some beats (seeded): the mesh snaps to a coarse grid and jumps sideways.
    const beatN = bpm > 0 ? Math.floor(((c - beatOffset) * bpm) / 60) : 0;
    const burst = glitch > 0 && bpm > 0 && hash1(beatN * 7.13 + (spec.seed || 1)) < glitch * 0.5 ? Math.exp(-5 * Math.max(0, beatPhase)) : 0;
    uniforms.uSnap.value = burst > 0.15 ? 6 + 10 * (1 - burst) : 0;
    group.position.x = burst > 0.15 ? (hash1(beatN * 3.7 + Math.floor(c * 30)) - 0.5) * 0.25 * burst : 0;
    edgeUniforms.uAlpha.value = showEdges ? Math.min(1, (0.95 + 0.6 * hit) * (1 - inflation)) : 0;
    group.rotation.set(0.42 + 0.2 * Math.sin(c * 0.37), c * spin * 0.6 * Math.PI, 0.1 * Math.sin(c * 0.23));
    group.scale.setScalar(1 + 0.03 * Math.sin(c * 1.3) + 0.05 * inflation + 0.07 * hit);
    shadow.scale.setScalar(1 + 0.08 * inflation);
    renderer.render(scene, camera);
  };
}

// ---------------------------------------------------------------------------------------------
// Footage FX: the scene's own video layer, re-drawn through a glitch shader. The renderer injects
// each video frame as an <img class="__render_frame__"> right after the <video> and then calls
// window.__hfReseekGpu(t); this layer reads that frame (or the live <video> in a preview) as a
// texture, so the effect follows the footage frame by frame. Everything else is a function of t.
// ---------------------------------------------------------------------------------------------
const FX_FRAG = /* glsl */ `
uniform sampler2D uTex; uniform float uHas; uniform float uTexAspect; uniform float uAspect;
uniform float uTime; uniform float uHit; uniform float uBurst; uniform float uInvert; uniform float uSeed;
uniform float uRgb; uniform float uWarp; uniform float uSort; uniform float uKaleido; uniform float uMirror;
uniform int uGrade; uniform float uDim; uniform float uGrain; uniform float uScan; uniform float uZoom; uniform vec3 uTint;
varying vec2 vUv;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453); }
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
vec2 cover(vec2 uv){
  vec2 s = uAspect > uTexAspect ? vec2(1.0, uTexAspect / uAspect) : vec2(uAspect / uTexAspect, 1.0);
  return clamp((uv - 0.5) * s / uZoom + 0.5, 0.0, 1.0);
}
vec3 tex(vec2 uv){ return texture2D(uTex, cover(uv)).rgb; }
vec3 hue(vec3 c, float a){
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
void main(){
  vec2 uv = vUv;
  if (uMirror > 0.5) uv.x = 0.5 - abs(uv.x - 0.5) * (uMirror > 1.5 ? -1.0 : 1.0);
  if (uKaleido > 1.5) {
    vec2 p = uv - 0.5; p.x *= uAspect;
    float r = length(p), a = atan(p.y, p.x) + uTime * 0.12;
    float seg = 6.28318 / uKaleido;
    a = mod(a, seg); a = abs(a - seg * 0.5);
    p = vec2(cos(a), sin(a)) * r; p.x /= uAspect;
    uv = p + 0.5;
  }
  // Liquid warp, stronger on the beat.
  float w = uWarp * (0.6 + 0.8 * uHit);
  uv += vec2(sin(uv.y * 9.0 + uTime * 1.7), cos(uv.x * 7.0 - uTime * 1.3)) * 0.012 * w;
  // Line tearing and block displacement in glitch bursts.
  float frameN = floor(uTime * 30.0);
  float row = floor(uv.y * 48.0);
  float tear = step(1.0 - uBurst * 0.55, hash(vec2(row, floor(frameN / 2.0))));
  uv.x += tear * (hash(vec2(row * 1.7, frameN)) - 0.5) * 0.18 * uBurst;
  vec2 blk = floor(uv * vec2(14.0, 8.0));
  if (hash(blk + frameN * 0.37) < uBurst * 0.32) uv += (vec2(hash(blk + 1.3), hash(blk + 2.1)) - 0.5) * 0.2 * uBurst;
  // Chromatic split.
  float sp = uRgb * (0.003 + 0.012 * uHit) + 0.03 * uBurst;
  vec3 col = vec3(tex(uv + vec2(sp, 0.0)).r, tex(uv).g, tex(uv - vec2(sp, sp * 0.4)).b);
  // Pixel-sort smear: bright pixels streak downwards.
  if (uSort > 0.0) {
    for (int i = 1; i <= 10; i++) {
      vec3 s = tex(uv + vec2(0.0, float(i) * 0.014 * uSort));
      float k = smoothstep(0.55, 0.85, lum(s)) * (1.0 - float(i) / 11.0);
      col = max(col, s * k);
    }
  }
  // Grades: 1 thermal, 2 acid, 3 mono, 4 tint duotone.
  float l = lum(col);
  if (uGrade == 1) col = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.1, 0.2) + l * 0.9 + 0.55));
  else if (uGrade == 2) col = hue(col * 1.25, uTime * 0.9 + l * 4.0);
  else if (uGrade == 3) col = vec3(smoothstep(0.12, 0.8, l));
  else if (uGrade == 4) col = mix(vec3(0.02, 0.01, 0.04), uTint, smoothstep(0.05, 0.9, l)) + pow(l, 4.0) * 0.6;
  // Posterize in bursts (datamosh-ish banding).
  if (uBurst > 0.3) col = floor(col * 5.0) / 5.0;
  col = mix(col, 1.0 - col, uInvert);
  col *= uDim;
  // Scanlines, grain, vignette.
  col *= 1.0 - uScan * 0.35 * step(0.5, fract(vUv.y * 270.0));
  col += (hash(vUv * 913.0 + frameN) - 0.5) * uGrain * 0.22;
  vec2 v = vUv - 0.5; col *= 1.0 - dot(v, v) * 1.1;
  col = mix(vec3(0.0), col, uHas);
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

const QUAD_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

function beatState(c: number, p: Record<string, number | string | boolean>, seed: number) {
  const bpm = Math.max(0, Math.min(240, Number(p.bpm ?? 0)));
  const beatOffset = Number(p.beatOffsetSec ?? 0);
  if (!(bpm > 0) || c < beatOffset) return { hit: 0, burst: 0, beatN: -1, phase: 0 };
  const u = ((c - beatOffset) * bpm) / 60;
  const beatN = Math.floor(u);
  const phase = u - beatN;
  const hit = Math.exp(-7 * phase);
  const rate = Math.max(0, Math.min(1, Number(p.glitch ?? 0.3)));
  const burst = hash1(beatN * 7.13 + seed) < rate * 0.6 ? Math.exp(-4 * phase) * rate : 0;
  return { hit, burst, beatN, phase };
}

function footageFx(canvas: HTMLCanvasElement, spec: ThreeLayerSpec): (t: number) => void {
  const p = spec.params;
  const renderer = track(new THREE.WebGLRenderer({ canvas, alpha: false, antialias: false, preserveDrawingBuffer: true }));
  renderer.setPixelRatio(1);
  renderer.setSize(spec.width, spec.height, false);
  const texture = new THREE.Texture();
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  const grade = ({ none: 0, thermal: 1, acid: 2, mono: 3, duotone: 4 } as Record<string, number>)[String(p.grade ?? "none")] ?? 0;
  const u = {
    uTex: { value: texture }, uHas: { value: 0 }, uTexAspect: { value: 16 / 9 }, uAspect: { value: spec.width / spec.height },
    uTime: { value: 0 }, uHit: { value: 0 }, uBurst: { value: 0 }, uInvert: { value: 0 }, uSeed: { value: (spec.seed % 97) * 0.731 },
    uRgb: { value: Number(p.rgbSplit ?? 0.5) }, uWarp: { value: Number(p.warp ?? 0.3) }, uSort: { value: Number(p.sort ?? 0) },
    uKaleido: { value: Math.round(Number(p.kaleido ?? 0)) }, uMirror: { value: ({ off: 0, left: 1, right: 2 } as Record<string, number>)[String(p.mirror ?? "off")] ?? 0 },
    uGrade: { value: grade }, uDim: { value: Number(p.brightness ?? 1) }, uGrain: { value: Number(p.grain ?? 0.4) }, uScan: { value: Number(p.scanlines ?? 0.3) },
    uZoom: { value: 1 }, uTint: { value: new THREE.Color(String(p.tint ?? "#ff4fd8")) },
  };
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms: u, vertexShader: QUAD_VERT, fragmentShader: FX_FRAG, depthTest: false })));
  const layerId = String(p.video ?? "");
  const clockOffset = Number(p.clockOffsetSec ?? 0);
  const strobe = Math.max(0, Math.min(1, Number(p.strobe ?? 0)));
  const punch = Math.max(0, Math.min(0.5, Number(p.beatZoom ?? 0.04)));
  const drift = Number(p.zoomDrift ?? 0.06);
  const glitchIn = Math.max(0, Math.min(1, Number(p.glitchIn ?? 0.6)));
  const findVideo = () => {
    const root = canvas.closest(".scene") ?? document;
    return (layerId ? root.querySelector<HTMLVideoElement>(`video[id$="-${layerId}"]`) : null) ?? root.querySelector<HTMLVideoElement>("video");
  };
  return (t: number) => {
    const c = t + clockOffset;
    const v = findVideo();
    const frame = v?.nextElementSibling as HTMLImageElement | null;
    let src: HTMLImageElement | HTMLVideoElement | null = null;
    if (frame && frame.classList.contains("__render_frame__") && frame.complete && frame.naturalWidth > 0) src = frame;
    else if (v && v.readyState >= 2 && v.videoWidth > 0) src = v;
    if (src) {
      texture.image = src;
      texture.needsUpdate = true;
      const sw = src instanceof HTMLVideoElement ? src.videoWidth : src.naturalWidth;
      const sh = src instanceof HTMLVideoElement ? src.videoHeight : src.naturalHeight;
      u.uTexAspect.value = sw / sh;
      u.uHas.value = 1;
    }
    const b = beatState(c, p, spec.seed || 1);
    const intro = glitchIn * Math.max(0, 1 - t / 0.35);
    u.uTime.value = c;
    u.uHit.value = b.hit;
    u.uBurst.value = Math.min(1, Math.max(b.burst, intro));
    u.uInvert.value = strobe > 0 && b.beatN >= 0 && hash1(b.beatN * 3.31 + 5) < strobe * 0.5 && b.phase < 0.12 ? 1 : 0;
    u.uZoom.value = 1 + drift * (t / Math.max(1, spec.durationSec)) + punch * b.hit;
    renderer.render(scene, camera);
  };
}

/**
 * Signal overlay: a transparent full-frame layer of analogue/digital noise for over everything
 * (text included): grain, scanlines, a rolling bar, beat strobes and noise bands in bursts.
 */
const SIGNAL_FRAG = /* glsl */ `
uniform float uTime; uniform float uHit; uniform float uBurst; uniform float uStrobe; uniform float uGrain; uniform float uScan; uniform float uRoll; uniform vec3 uColor;
varying vec2 vUv;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  float f = floor(uTime * 30.0);
  float g = hash(vUv * 731.0 + f) - 0.5;
  float a = abs(g) * uGrain * 0.25;
  vec3 col = vec3(step(0.0, g));
  float scan = step(0.5, fract(vUv.y * 360.0)) * uScan * 0.18;
  float roll = smoothstep(0.0, 0.06, fract(vUv.y - uTime * 0.11) ) * (1.0 - smoothstep(0.06, 0.12, fract(vUv.y - uTime * 0.11))) * uRoll * 0.12;
  float band = step(1.0 - uBurst * 0.4, hash(vec2(floor(vUv.y * 22.0), f))) * uBurst;
  vec3 bandC = vec3(hash(vec2(f, 1.0)), hash(vec2(f, 2.0)), hash(vec2(f, 3.0)));
  // Premultiplied output: dark scanlines, light/dark grain, bright bands and strobes.
  vec4 o = vec4(col * a, a);
  o = o * (1.0 - scan) + vec4(0.0, 0.0, 0.0, scan);
  o += vec4(vec3(roll), roll);
  o = mix(o, vec4(bandC * 0.8, 0.8), band * 0.55);
  o = mix(o, vec4(uColor, 1.0), uStrobe);
  gl_FragColor = o;
}`;

function signalOverlay(canvas: HTMLCanvasElement, spec: ThreeLayerSpec): (t: number) => void {
  const p = spec.params;
  const renderer = track(new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, preserveDrawingBuffer: true }));
  renderer.setPixelRatio(1);
  renderer.setSize(spec.width, spec.height, false);
  renderer.setClearColor(0x000000, 0);
  const u = {
    uTime: { value: 0 }, uHit: { value: 0 }, uBurst: { value: 0 }, uStrobe: { value: 0 },
    uGrain: { value: Number(p.grain ?? 0.5) }, uScan: { value: Number(p.scanlines ?? 0.5) }, uRoll: { value: Number(p.roll ?? 0.5) },
    uColor: { value: new THREE.Color(String(p.strobeColor ?? "#ffffff")) },
  };
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms: u, vertexShader: QUAD_VERT, fragmentShader: SIGNAL_FRAG, transparent: true, depthTest: false, premultipliedAlpha: true, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor })));
  const clockOffset = Number(p.clockOffsetSec ?? 0);
  const strobe = Math.max(0, Math.min(1, Number(p.strobe ?? 0)));
  return (t: number) => {
    const c = t + clockOffset;
    const b = beatState(c, p, (spec.seed || 1) + 13);
    u.uTime.value = c;
    u.uHit.value = b.hit;
    u.uBurst.value = b.burst;
    u.uStrobe.value = strobe > 0 && b.beatN >= 0 && hash1(b.beatN * 5.17 + 2) < strobe * 0.35 && b.phase < 0.07 ? 0.85 : 0;
    renderer.clear();
    renderer.render(scene, camera);
  };
}

const COMPONENTS: Record<string, (canvas: HTMLCanvasElement, spec: ThreeLayerSpec) => (t: number) => void> = {
  "platonic-shader@1": platonicShader,
  "footage-fx@1": footageFx,
  "signal-overlay@1": signalOverlay,
};

const layers: Layer[] = [];
const report = (w.__vsThreeReport = { layers: 0, frames: 0, errors: [] as string[] });

async function setup() {
  const specs = ((w.__vsGraphics ?? []) as ThreeLayerSpec[]).filter((s) => s.backend === "three");
  for (const spec of specs) {
    const make = COMPONENTS[`${spec.component}@${spec.version}`];
    if (!make) throw new Error(`Unsupported three.js component ${spec.component}@${spec.version}`);
    if (!document.getElementById(`gfx-${spec.id}`)) throw new Error(`Missing canvas for ${spec.id}`);
    layers.push({ spec, make, live: null, lastT: null });
  }
  report.layers = layers.length;
}

/** Build the layer on a fresh canvas (a released context cannot be reused). */
function wake(L: Layer) {
  const old = document.getElementById(`gfx-${L.spec.id}`) as HTMLCanvasElement;
  const canvas = old.cloneNode(false) as HTMLCanvasElement;
  old.replaceWith(canvas);
  building = [];
  const draw = L.make(canvas, L.spec);
  L.live = { draw, renderers: building };
  building = [];
  L.lastT = null;
}

function sleep(L: Layer) {
  for (const r of L.live?.renderers ?? []) {
    r.dispose();
    r.forceContextLoss();
  }
  L.live = null;
  L.lastT = null;
}

function drawAll(time: number, force = false) {
  for (const L of layers) {
    const t = time - L.spec.startSec;
    if (t < -1e-6 || t > L.spec.durationSec + 1e-6) {
      // Off screen: give the context back unless the scene is about to come round again.
      if (L.live && (t < -1 || t > L.spec.durationSec + 0.5)) sleep(L);
      continue;
    }
    if (!L.live) wake(L);
    const tt = Math.max(0, Math.min(t, L.spec.durationSec));
    if (L.lastT === tt && !force) continue;
    try {
      L.live!.draw(tt);
      L.lastT = tt;
      report.frames++;
    } catch (e) {
      report.errors.push(String(e));
      throw e;
    }
  }
}

w.__hf = w.__hf || {};
w.__hf.buildReady = w.__hf.buildReady || {};
const ready = setup();
w.__hf.buildReady["vs-three"] = ready;
window.addEventListener("hf-seek", (e: Event) => {
  const d = (e as CustomEvent<{ time: number; waitUntil?: (p: Promise<unknown>) => void }>).detail;
  const p = ready.then(() => drawAll(d.time));
  d.waitUntil?.(p);
});
let isReady = false;
ready.then(() => {
  isReady = true;
  drawAll(0);
}).catch((e) => report.errors.push(String(e)));
// After the renderer injects this frame's video images it calls __hfReseekGpu: redraw (in the
// same task, before capture) so footage effects use the new frame. Chained with other runtimes.
type ReseekWindow = { __hfReseekGpu?: (t: number) => void };
const prevReseek = (window as unknown as ReseekWindow).__hfReseekGpu;
(window as unknown as ReseekWindow).__hfReseekGpu = (t: number) => {
  prevReseek?.(t);
  if (isReady) drawAll(t, true);
};
