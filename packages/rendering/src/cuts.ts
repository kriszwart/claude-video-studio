import { ANALYSIS_SR, decodeMono } from "./music";

export interface CleanCut {
  /** Cut time in source seconds. */
  timeSec: number;
  /** Detected speech edge (onset for "in", offset for "out") in source seconds. */
  speechEdgeSec: number;
  /** RMS level over 40 ms centred on the cut, dBFS. */
  levelDb: number;
  /** Speech threshold used, dBFS. */
  thresholdDb: number;
  /** True when no pause was found inside the allowed range (the cut sits at the boundary). */
  tight: boolean;
}

const HOP = 0.01;
const WIN = 0.04;

function rmsDb(x: Float32Array, sr: number, centreSec: number): number {
  const half = Math.round((WIN / 2) * sr);
  const c = Math.round(centreSec * sr);
  let s = 0;
  let n = 0;
  for (let i = Math.max(0, c - half); i < Math.min(x.length, c + half); i++) {
    s += x[i]! * x[i]!;
    n++;
  }
  return n ? 10 * Math.log10(s / n + 1e-12) : -120;
}

/**
 * Find a clean cut near a transcript boundary by listening to the audio: locate where the
 * speech actually starts (or ends), then leave a short handle of room tone before (after)
 * it without entering the neighbouring words. Works on segment-level timestamps that may be
 * slightly early or late.
 *
 * - edge: the transcript's boundary (segment start for "in", end for "out")
 * - bound: the neighbouring speech boundary that must not be crossed (previous segment end
 *   for "in", next segment start for "out"), or the file edge
 */
export function findCleanCut(x: Float32Array, sr: number, regionStartSec: number, edge: number, bound: number, side: "in" | "out", opts: { handleSec?: number; slackSec?: number } = {}): CleanCut {
  const handle = opts.handleSec ?? 0.15;
  const slack = opts.slackSec ?? 0.25;
  const local = (t: number) => t - regionStartSec;
  // Noise floor from the quietest 10% of the region; speech is > floor + 15 dB (and > -50 dBFS).
  const levels: number[] = [];
  for (let t = 0; t < x.length / sr; t += HOP) levels.push(rmsDb(x, sr, t));
  const sorted = [...levels].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? -90;
  const thr = Math.max(floor + 15, -50);
  const loud = (t: number) => rmsDb(x, sr, local(t)) > thr;

  if (side === "in") {
    const lo = Math.max(bound, edge - slack - handle);
    // Walk back from just after the boundary until the audio is quiet: that's the onset.
    let t = edge + 0.05;
    while (t > lo && loud(t)) t -= HOP;
    const onset = Math.min(edge, t + HOP);
    const cut = Math.max(lo, Math.min(onset, edge) - handle);
    const tight = t <= lo + 1e-9;
    return { timeSec: round(cut), speechEdgeSec: round(onset), levelDb: round(rmsDb(x, sr, local(cut))), thresholdDb: round(thr), tight };
  }
  const hi = Math.min(bound, edge + slack + handle);
  let t = edge - 0.05;
  while (t < hi && loud(t)) t += HOP;
  const offset = Math.max(edge, t - HOP);
  const cut = Math.min(hi, Math.max(offset, edge) + handle);
  const tight = t >= hi - 1e-9;
  return { timeSec: round(cut), speechEdgeSec: round(offset), levelDb: round(rmsDb(x, sr, local(cut))), thresholdDb: round(thr), tight };
}

/** Decode the audio around a quote and find both clean cuts. */
export async function measureQuoteCuts(file: string, q: { speechInSec: number; speechOutSec: number; prevEndSec: number; nextStartSec: number }, opts: { handleSec?: number } = {}) {
  const pad = 1.2;
  const start = Math.max(0, Math.min(q.speechInSec, q.prevEndSec) - pad);
  const end = Math.max(q.speechOutSec, Number.isFinite(q.nextStartSec) ? q.nextStartSec : q.speechOutSec) + pad;
  const x = await decodeMono(file, { startSec: start, durationSec: end - start });
  const sr = ANALYSIS_SR;
  const fileEnd = start + x.length / sr;
  const cin = findCleanCut(x, sr, start, q.speechInSec, Math.max(0, q.prevEndSec), "in", opts);
  const cout = findCleanCut(x, sr, start, q.speechOutSec, Math.min(fileEnd, q.nextStartSec), "out", opts);
  return { in: cin, out: cout };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
