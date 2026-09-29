import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeMusicFile } from "../src/music";

const FIX = join(import.meta.dirname, "../../../fixtures/sample");
const fmeasure = (est: number[], ref: number[], tol = 0.07) => {
  const hit = (xs: number[], ys: number[]) => xs.filter((x) => ys.some((y) => Math.abs(x - y) <= tol)).length;
  const p = hit(est, ref) / est.length;
  const r = hit(ref, est) / ref.length;
  return (2 * p * r) / (p + r);
};

describe("music analysis", () => {
  it("recovers tempo, beats, downbeats and sections of the sample song", async () => {
    const gt = JSON.parse(readFileSync(join(FIX, "music-song.json"), "utf8"));
    const a = await analyzeMusicFile(join(FIX, "music-song.m4a"));
    expect(Math.abs(a.bpm - 120)).toBeLessThan(1);
    expect(fmeasure(a.beats, gt.beats)).toBeGreaterThan(0.95);
    // Downbeats every 2 s (4/4 at 120 BPM).
    expect(fmeasure(a.downbeats.filter((d) => d > 0), gt.beats.filter((_: number, i: number) => i % 4 === 0))).toBeGreaterThan(0.95);
    expect(a.sections.map((s) => Math.round(s.startSec))).toEqual(gt.sections.map((s: { start: number }) => s.start));
    expect(a.sections.map((s) => s.label)).toEqual(["intro", "verse", "chorus", "verse", "chorus", "outro"]);
  }, 60_000);

  it("stays accurate on a tempo-stretched, noisy version (102 BPM)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-music-"));
    const out = join(dir, "stretched.wav");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(FIX, "music-song.m4a"), "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.05:d=120", "-filter_complex", "[0:a]atempo=0.85,aresample=44100[m];[1:a]aresample=44100[n];[m][n]amix=inputs=2:duration=first:normalize=0", "-ac", "1", out]);
    const gt = JSON.parse(readFileSync(join(FIX, "music-song.json"), "utf8"));
    const a = await analyzeMusicFile(out);
    expect(Math.abs(a.bpm - 102)).toBeLessThan(1.5);
    expect(fmeasure(a.beats, gt.beats.map((b: number) => b / 0.85))).toBeGreaterThan(0.9);
    const want = gt.sections.map((s: { start: number }) => s.start / 0.85);
    const got = a.sections.map((s) => s.startSec);
    expect(want.filter((w: number) => got.some((g) => Math.abs(g - w) < 0.6)).length).toBeGreaterThanOrEqual(want.length - 1);
  }, 60_000);
});
