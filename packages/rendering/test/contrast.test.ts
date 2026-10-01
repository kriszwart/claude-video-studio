import { describe, expect, it } from "vitest";
import { contrastRatio, lowContrast, measureContrast, type TextRun } from "../src/contrast";

/** An RGB24 frame filled with one colour, with an optional rectangle of another. */
function frame(w: number, h: number, fill: number[], patch?: { x: number; y: number; w: number; h: number; rgb: number[] }) {
  const b = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = patch && x >= patch.x && x < patch.x + patch.w && y >= patch.y && y < patch.y + patch.h ? patch.rgb : fill;
      b.set(c, (y * w + x) * 3);
    }
  return b;
}
const run = (rgb: [number, number, number], halo = false): TextRun => ({ id: "l-scn-lay", rgb, halo, rects: [{ x: 10, y: 10, w: 80, h: 20 }] });

describe("text contrast", () => {
  it("matches the WCAG ratio at the extremes", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.48, 1);
  });

  it("passes white on near-black and flags dark indigo on indigo", () => {
    const [ok] = measureContrast([run([255, 255, 255])], frame(100, 40, [20, 20, 30]), 100, 40, 0, 1);
    expect(ok!.ratio).toBeGreaterThan(15);
    expect(lowContrast(ok!)).toBe(false);
    const [bad] = measureContrast([run([43, 45, 107])], frame(100, 40, [82, 74, 227]), 100, 40, 2, 3.5);
    expect(bad).toMatchObject({ frame: 2, timeSec: 3.5, text: "#2b2d6b", background: "#524ae3" });
    expect(bad!.ratio).toBeLessThan(3);
    expect(lowContrast(bad!)).toBe(true);
  });

  it("judges by the worst part of the background, not the average", () => {
    // A light band covers a third of the line: white text is unreadable there.
    const [m] = measureContrast([run([255, 255, 255])], frame(100, 40, [10, 10, 10], { x: 10, y: 10, w: 30, h: 20, rgb: [240, 240, 240] }), 100, 40, 0, 0);
    expect(m!.ratio).toBeLessThan(1.2);
  });

  it("is lenient with a shadow or outline, and skips text too small to sample", () => {
    const grey = frame(100, 40, [150, 150, 150]);
    const plain = measureContrast([run([255, 255, 255])], grey, 100, 40, 0, 0)[0]!;
    const haloed = measureContrast([run([255, 255, 255], true)], grey, 100, 40, 0, 0)[0]!;
    expect(lowContrast(plain)).toBe(true);
    expect(lowContrast(haloed)).toBe(false);
    expect(measureContrast([{ ...run([0, 0, 0]), rects: [{ x: 0, y: 0, w: 3, h: 3 }] }], grey, 100, 40, 0, 0)).toEqual([]);
  });
});
