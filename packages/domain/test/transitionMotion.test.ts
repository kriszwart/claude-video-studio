import { describe, expect, it } from "vitest";
import { grainAt, lensAt, lensGeometry, liquidFront, liquidGeometry, liquidSettle, morphAt, morphCover, morphShapeRadius, progressAt } from "../src";

const W = 1920, H = 1080, unit = 1;

describe("shader transition motion", () => {
  it("liquid: the front starts fully off the left edge and ends fully past the right, and the wobble settles", () => {
    const g = liquidGeometry(7, W, H, unit);
    for (let y = 0; y <= H; y += 27) {
      expect(liquidFront(g, 0, y)).toBeLessThan(0);
      expect(liquidFront(g, 1, y)).toBeGreaterThan(W);
    }
    // Monotone sweep: the middle of the front only moves right.
    let last = -Infinity;
    for (let f = 0; f <= 20; f++) {
      const x = liquidFront(g, progressAt(f, 20), H / 2);
      expect(x).toBeGreaterThan(last - 40); // waves ripple, the front still advances
      last = x;
    }
    expect(liquidSettle(0)).toBe(1);
    expect(liquidSettle(1)).toBe(0);
  });

  it("lens: starts as nothing, covers the whole frame at the end, magnification eases to 1", () => {
    const g = lensGeometry(3, W, H, unit);
    expect(lensAt(g, 0).r).toBe(0);
    const end = lensAt(g, 1);
    expect(Math.hypot(Math.max(end.cx, W - end.cx), Math.max(end.cy, H - end.cy))).toBeLessThan(end.r);
    expect(end.mag).toBeCloseTo(1, 5);
    expect(lensAt(g, 0.3).mag).toBeGreaterThan(1.2);
  });

  it("grain: no next-scene pixels at the start, all of them by the last frame, fringe peaks mid-way", () => {
    // Fractal noise sits between about 0.2 and 0.8: alpha = slope × (noise − threshold).
    expect(grainAt(0, 1).threshold).toBeGreaterThanOrEqual(0.78);
    expect(grainAt(progressAt(19, 20), 1).threshold).toBeLessThan(0.2 - 1 / 10);
    expect(grainAt(0.5, 1).fringe).toBeGreaterThan(grainAt(0.1, 1).fringe);
    expect(grainAt(0, 1).fringe).toBe(0);
  });

  it("morph: the shape covers the frame at both ends and closes to nothing at the swap", () => {
    const cover = morphCover(W, H, unit);
    const corner = Math.hypot(W / 2, H / 2);
    // Even the star's narrowest point (0.56) covers the corners at full size.
    expect(cover * 0.56).toBeGreaterThan(corner);
    for (let a = 0; a < 6.3; a += 0.1) expect(morphShapeRadius(1, a)).toBeGreaterThanOrEqual(0.559);
    expect(morphAt(W, H, unit, 0).size).toBeCloseTo(cover);
    expect(morphAt(W, H, unit, 0.5).size).toBeCloseTo(0);
    expect(morphAt(W, H, unit, 1).size).toBeCloseTo(cover);
    expect(morphAt(W, H, unit, 0.25).phase).toBe(0);
    expect(morphAt(W, H, unit, 0.75).phase).toBe(1);
    // The shrinking scene always fills the part of the shape that is on screen.
    for (let p = 0; p < 0.5; p += 0.02) {
      const m = morphAt(W, H, unit, p);
      expect(m.sceneScale * (W / 2)).toBeGreaterThanOrEqual(Math.min(W / 2, 1.19 * m.size) - 1e-6);
    }
  });
});
