import { describe, expect, it } from "vitest";
import { inflate, len, morphAt, morphTotal, SOLIDS, subdivide, type V3 } from "../src/runtime/polyhedra";

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

describe("platonic solids", () => {
  it.each([
    ["tetrahedron", 4, 4, 6, 3],
    ["cube", 8, 6, 12, 4],
    ["octahedron", 6, 8, 12, 3],
    ["dodecahedron", 20, 12, 30, 5],
    ["icosahedron", 12, 20, 30, 3],
  ])("%s has the right vertices, faces, edges and face size, wound outward", (name, v, f, e, sides) => {
    const s = SOLIDS[name]!;
    expect([s.vertices.length, s.faces.length, s.edges.length]).toEqual([v, f, e]);
    expect(s.faces.every((face) => face.length === sides)).toBe(true);
    for (const face of s.faces) {
      const [a, b, c] = face.map((i) => s.vertices[i]!) as [V3, V3, V3];
      expect(dot(cross(sub(b, a), sub(c, a)), a)).toBeGreaterThan(0); // counter-clockwise from outside
    }
    expect(s.vertices.every((p) => Math.abs(len(p) - 1) < 1e-9)).toBe(true);
  });

  it("subdivides into 4^level triangles per fan triangle, which inflate onto the unit sphere", () => {
    const tris = subdivide(SOLIDS.cube!, 2);
    expect(tris.length).toBe(6 * 4 * 16);
    for (const t of tris) for (const p of t.p) expect(len(inflate(p, 1))).toBeCloseTo(1, 9);
  });
});

describe("morph timeline", () => {
  const hold = 2, morph = 1.5;
  it("starts on the first solid, hands over at the sphere, and holds the last one", () => {
    expect(morphAt(0, 5, hold, morph)).toMatchObject({ index: 0, inflation: 0 });
    // Halfway through the first morph both sides are the full sphere.
    const at = hold + morph / 2;
    expect(morphAt(at - 1e-6, 5, hold, morph)).toMatchObject({ index: 0 });
    expect(morphAt(at - 1e-6, 5, hold, morph).inflation).toBeCloseTo(1, 4);
    expect(morphAt(at + 1e-6, 5, hold, morph)).toMatchObject({ index: 1 });
    expect(morphAt(at + 1e-6, 5, hold, morph).inflation).toBeCloseTo(1, 4);
    expect(morphAt(hold + morph, 5, hold, morph)).toMatchObject({ index: 1, inflation: 0 });
    const total = morphTotal(5, hold, morph);
    expect(total).toBe(5 * 2 + 4 * 1.5);
    expect(morphAt(total + 3, 5, hold, morph)).toMatchObject({ index: 4, inflation: 0, progress: 1 });
  });
});
