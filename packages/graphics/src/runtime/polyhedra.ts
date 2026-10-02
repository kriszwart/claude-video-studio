/**
 * Platonic solids for the platonic-morph component: vertices on the unit sphere, faces found as
 * the convex hull's planes (ordered counter-clockwise seen from outside), edges from the faces.
 * Pure and deterministic, so it runs the same in tests and in the page.
 */

export type V3 = [number, number, number];
export interface Solid {
  name: string;
  vertices: V3[];
  /** Vertex indices per face, counter-clockwise seen from outside. */
  faces: number[][];
  edges: [number, number][];
}

const PHI = (1 + Math.sqrt(5)) / 2;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3) => Math.sqrt(dot(a, a));
export const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
export const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function hull(name: string, raw: V3[]): Solid {
  const vertices = raw.map(norm);
  const n = vertices.length;
  const faces: number[][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++) {
        let normal = cross(sub(vertices[j]!, vertices[i]!), sub(vertices[k]!, vertices[i]!));
        if (len(normal) < 1e-9) continue;
        normal = norm(normal);
        let d = dot(normal, vertices[i]!);
        if (d < 0) {
          normal = mul(normal, -1);
          d = -d;
        }
        // A face plane has every vertex on or behind it.
        if (vertices.some((v) => dot(normal, v) > d + 1e-6)) continue;
        const on = vertices.map((v, idx) => (Math.abs(dot(normal, v) - d) < 1e-6 ? idx : -1)).filter((x) => x >= 0);
        const key = on.join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        // Order around the face centre, counter-clockwise seen from outside (along +normal).
        const c = mul(on.reduce((a, idx) => add(a, vertices[idx]!), [0, 0, 0] as V3), 1 / on.length);
        const u = norm(sub(vertices[on[0]!]!, c));
        const w = cross(normal, u);
        on.sort((a, b) => {
          const pa = sub(vertices[a]!, c), pb = sub(vertices[b]!, c);
          return Math.atan2(dot(pa, w), dot(pa, u)) - Math.atan2(dot(pb, w), dot(pb, u));
        });
        faces.push(on);
      }
  const edgeSet = new Map<string, [number, number]>();
  for (const f of faces)
    f.forEach((a, i) => {
      const b = f[(i + 1) % f.length]!;
      edgeSet.set(a < b ? `${a}-${b}` : `${b}-${a}`, a < b ? [a, b] : [b, a]);
    });
  return { name, vertices, faces, edges: [...edgeSet.values()] };
}

const cyc = (x: number, y: number, z: number): V3[] => [[x, y, z], [y, z, x], [z, x, y]];
function signs(p: V3): V3[] {
  const out: V3[] = [];
  for (const sx of p[0] ? [1, -1] : [1]) for (const sy of p[1] ? [1, -1] : [1]) for (const sz of p[2] ? [1, -1] : [1]) out.push([p[0] * sx, p[1] * sy, p[2] * sz]);
  return out;
}

export const SOLIDS: Record<string, Solid> = {
  tetrahedron: hull("tetrahedron", [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]]),
  cube: hull("cube", signs([1, 1, 1])),
  octahedron: hull("octahedron", [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]),
  dodecahedron: hull("dodecahedron", [...signs([1, 1, 1]), ...cyc(0, 1 / PHI, PHI).flatMap(signs)]),
  icosahedron: hull("icosahedron", cyc(0, 1, PHI).flatMap(signs)),
};

export interface Tri {
  /** Three points on the (un-inflated) solid. */
  p: [V3, V3, V3];
  face: number;
}

/** Faces fanned from their centre, then each triangle split into 4^level smaller ones. */
export function subdivide(s: Solid, level: number): Tri[] {
  const out: Tri[] = [];
  const split = (a: V3, b: V3, c: V3, l: number, face: number) => {
    if (l === 0) return void out.push({ p: [a, b, c], face });
    const ab = lerp3(a, b, 0.5), bc = lerp3(b, c, 0.5), ca = lerp3(c, a, 0.5);
    split(a, ab, ca, l - 1, face);
    split(ab, b, bc, l - 1, face);
    split(ca, bc, c, l - 1, face);
    split(ab, bc, ca, l - 1, face);
  };
  s.faces.forEach((f, fi) => {
    const c = mul(f.reduce((a, idx) => add(a, s.vertices[idx]!), [0, 0, 0] as V3), 1 / f.length);
    f.forEach((a, i) => split(c, s.vertices[a]!, s.vertices[f[(i + 1) % f.length]!]!, level, fi));
  });
  return out;
}

/** Push a point toward the unit sphere: 0 = on the solid, 1 = on the sphere. */
export const inflate = (p: V3, s: number): V3 => lerp3(p, norm(p), s);

export interface MorphState {
  /** Index into the sequence of the solid being drawn. */
  index: number;
  /** 0 = the solid, 1 = fully inflated to a sphere. */
  inflation: number;
  /** 0..1 through the whole sequence, for colour drift. */
  progress: number;
}

const smooth = (x: number) => x * x * (3 - 2 * x);

/**
 * Where the morph is at time t. Each solid holds, then inflates to a sphere; the next solid
 * deflates out of that same sphere (at inflation 1 both are the sphere, so the switch is
 * seamless). The first solid starts as itself and the last one holds to the end.
 */
export function morphAt(t: number, count: number, holdSec: number, morphSec: number): MorphState {
  const cycle = holdSec + morphSec;
  const total = count * holdSec + (count - 1) * morphSec;
  const u = Math.max(0, Math.min(t, total));
  const k = Math.min(count - 1, Math.floor(u / cycle));
  const local = u - k * cycle;
  const half = morphSec / 2;
  const progress = total > 0 ? u / total : 0;
  if (k === count - 1 || local < holdSec) return { index: k, inflation: 0, progress };
  if (local < holdSec + half) return { index: k, inflation: smooth((local - holdSec) / half), progress };
  return { index: k + 1, inflation: 1 - smooth((local - holdSec - half) / half), progress };
}

/** Length of a full sequence: every solid held once, with a morph between each pair. */
export const morphTotal = (count: number, holdSec: number, morphSec: number) => count * holdSec + (count - 1) * morphSec;
