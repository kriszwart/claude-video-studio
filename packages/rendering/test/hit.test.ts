import { describe, expect, it } from "vitest";
import { hitFromSamples } from "../src/hit";

const SR = 16_000;
const burst = (out: Float32Array, atSec: number, lenSec: number, amp: number) => {
  for (let i = Math.round(atSec * SR); i < Math.min(out.length, Math.round((atSec + lenSec) * SR)); i++) out[i] = amp * Math.sin(i * 0.9);
};

describe("sound hit", () => {
  it("a click with press and release equally loud hits on the press", () => {
    const s = new Float32Array(SR * 0.4);
    burst(s, 0.03, 0.01, 0.8); // press
    burst(s, 0.156, 0.01, 0.82); // release, a touch louder
    const h = hitFromSamples(s, SR);
    expect(h.hitSec).toBeCloseTo(0.03, 2);
    expect(h.peakSec).toBeGreaterThan(0.15); // the loudest moment is the release
  });

  it("a swelling whoosh hits near its peak", () => {
    const s = new Float32Array(SR * 1.2);
    for (let i = 0; i < s.length; i++) {
      const t = i / SR;
      const env = t < 0.712 ? (t / 0.712) ** 3 : Math.max(0, 1 - (t - 0.712) / 0.4);
      s[i] = env * Math.sin(i * 0.7);
    }
    const h = hitFromSamples(s, SR);
    expect(h.hitSec).toBeGreaterThan(0.55);
    expect(h.hitSec).toBeLessThanOrEqual(0.72);
    expect(h.durationSec).toBeCloseTo(1.2, 2);
  });
});
