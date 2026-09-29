import { describe, expect, it } from "vitest";
import { findCleanCut } from "../src/cuts";

const SR = 22050;
/** Room tone with "speech" (a modulated tone) in the given spans. */
function signal(durSec: number, speech: [number, number][]) {
  const x = new Float32Array(Math.round(durSec * SR));
  let seed = 7;
  for (let i = 0; i < x.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    x[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.003;
    const t = i / SR;
    if (speech.some(([a, b]) => t >= a && t < b)) x[i]! += 0.3 * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t));
  }
  return x;
}

describe("findCleanCut", () => {
  // Words: previous sentence 0.5–2.0, quote 2.6–5.0, next sentence 5.7–7.0.
  const x = signal(8, [[0.5, 2.0], [2.6, 5.0], [5.7, 7.0]]);

  it("cuts in the pause with a handle when stamps are exact", () => {
    const cin = findCleanCut(x, SR, 0, 2.6, 2.0, "in");
    const cout = findCleanCut(x, SR, 0, 5.0, 5.7, "out");
    expect(cin.timeSec).toBeGreaterThan(2.0);
    expect(cin.timeSec).toBeLessThan(2.6);
    expect(cout.timeSec).toBeGreaterThan(5.0);
    expect(cout.timeSec).toBeLessThan(5.7);
    expect(cin.levelDb).toBeLessThan(cin.thresholdDb);
    expect(cout.levelDb).toBeLessThan(cout.thresholdDb);
    expect(cin.tight || cout.tight).toBe(false);
  });

  it("keeps the first and last words when the transcript stamps are late/early", () => {
    // Subtitle says the quote starts at 2.8 (speech really starts 2.6) and ends at 4.8 (really 5.0).
    const cin = findCleanCut(x, SR, 0, 2.8, 2.0, "in");
    const cout = findCleanCut(x, SR, 0, 4.8, 5.7, "out");
    expect(cin.speechEdgeSec).toBeLessThanOrEqual(2.62);
    expect(cin.timeSec).toBeLessThan(2.6);
    expect(cout.speechEdgeSec).toBeGreaterThanOrEqual(4.98);
    expect(cout.timeSec).toBeGreaterThan(5.0);
    expect(cout.timeSec).toBeLessThanOrEqual(5.7);
  });

  it("never crosses into the neighbouring sentence", () => {
    const y = signal(6, [[0.5, 2.55], [2.6, 4.0], [4.05, 5.5]]);
    const cin = findCleanCut(y, SR, 0, 2.6, 2.55, "in");
    const cout = findCleanCut(y, SR, 0, 4.0, 4.05, "out");
    expect(cin.timeSec).toBeGreaterThanOrEqual(2.55);
    expect(cout.timeSec).toBeLessThanOrEqual(4.05);
  });
});
