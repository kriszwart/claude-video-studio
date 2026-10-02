import { describe, expect, it } from "vitest";
import { findGlitches, loopSeam, type GreyFrames } from "../src/framescan";

const W = 64, H = 36;
/** A frame with a white 8×8 square at (x, y) on grey. */
const frame = (x: number, y = 14, bg = 60) => {
  const f = new Uint8Array(W * H).fill(bg);
  for (let yy = y; yy < y + 8; yy++) for (let xx = x; xx < x + 8; xx++) if (xx >= 0 && xx < W) f[yy * W + xx] = 230;
  return f;
};
const clip = (frames: Uint8Array[]): GreyFrames => ({ width: W, height: H, fps: 30, frames });
const glide = (n: number) => Array.from({ length: n }, (_, i) => frame(4 + i)); // 1 px a frame

describe("frame scan", () => {
  it("smooth motion and a still picture are clean", () => {
    expect(findGlitches(clip(glide(50)))).toEqual([]);
    expect(findGlitches(clip(Array.from({ length: 30 }, () => frame(20))))).toEqual([]);
  });

  it("finds a one-frame flash, even in footage where jumps are not judged", () => {
    const f = glide(40);
    f[20] = frame(4 + 20, 14, 200); // the background lights up for one frame
    const g = findGlitches(clip(f), [], () => true);
    expect(g).toEqual([expect.objectContaining({ kind: "flash", frame: 20 })]);
    expect(g[0]!.timeSec).toBeCloseTo(20 / 30, 2);
  });

  it("finds a jump outside cuts, but not at a cut", () => {
    const f = [...Array.from({ length: 20 }, () => frame(10)), ...Array.from({ length: 20 }, () => frame(44))];
    expect(findGlitches(clip(f))).toEqual([expect.objectContaining({ kind: "jump", frame: 20 })]);
    expect(findGlitches(clip(f), [20])).toEqual([]);
    expect(findGlitches(clip(f), [], (i) => i >= 15)).toEqual([]);
  });

  it("measures the loop seam", () => {
    expect(loopSeam(clip([frame(10), frame(30), frame(10)]))).toBe(0);
    expect(loopSeam(clip([frame(10), frame(30), frame(40)]))).toBeGreaterThan(10);
  });
});
