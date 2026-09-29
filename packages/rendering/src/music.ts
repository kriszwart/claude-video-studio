/**
 * Music analysis (FR-09, T6): tempo, beats, downbeats and section boundaries proposed from
 * the actual audio. Everything here is a proposal: markers are stored unverified and the
 * owner can move, add or delete them. Pure DSP over PCM, plus an ffmpeg decode helper.
 *
 * Method (standard, documented so results are explainable):
 *  - onset envelope: half-wave-rectified log-magnitude spectral flux (1024/256 @ 22.05 kHz);
 *  - tempo: autocorrelation of the envelope with a log-normal prior around 120 BPM;
 *  - beats: dynamic-programming beat tracker (Ellis 2007) on that tempo;
 *  - downbeats: 4/4 assumed; the bar phase with the strongest low-band onsets;
 *  - sections: per-bar spectral/loudness features, checkerboard novelty on the
 *    self-similarity matrix, peaks snapped to bar lines; labels from energy and repetition.
 */
import { FFMPEG, runOk } from "./exec";

export const ANALYSIS_SR = 22050;
const N_FFT = 1024;
const HOP = 256;

export interface MusicAnalysis {
  version: string;
  durationSec: number;
  bpm: number;
  /** 0..1 — how peaked the tempo autocorrelation is; low values mean an unreliable grid. */
  tempoConfidence: number;
  beats: number[];
  downbeats: number[];
  sections: { startSec: number; endSec: number; label: string; energy: number }[];
  /** Hop duration of the onset envelope (seconds). */
  hopSec: number;
}

export const MUSIC_ANALYSIS_VERSION = "vs-music/1";

export async function decodeMono(file: string, opts: { startSec?: number; durationSec?: number } = {}): Promise<Float32Array> {
  const r = await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", ...(opts.startSec ? ["-ss", String(opts.startSec)] : []), "-i", file, ...(opts.durationSec ? ["-t", String(opts.durationSec)] : []), "-vn", "-ac", "1", "-ar", String(ANALYSIS_SR), "-f", "f32le", "-"], { timeoutMs: 600_000 });
  const b = r.stdoutBuffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

// --- FFT (iterative radix-2, in place) -------------------------------------------------
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const N_BANDS = 12;

/** Log-magnitude spectrogram features: onset envelope, low-band onsets, band energies, RMS. */
function features(pcm: Float32Array) {
  const frames = Math.max(1, Math.floor((pcm.length - N_FFT) / HOP) + 1);
  const bins = N_FFT / 2;
  const win = new Float64Array(N_FFT).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT));
  // Log-spaced band edges from ~60 Hz to Nyquist.
  const edges: number[] = [];
  for (let b = 0; b <= N_BANDS; b++) edges.push(Math.min(bins, Math.max(1, Math.round((60 * Math.pow(ANALYSIS_SR / 2 / 60, b / N_BANDS)) / (ANALYSIS_SR / N_FFT)))));
  const lowBin = Math.round(200 / (ANALYSIS_SR / N_FFT));
  const onset = new Float64Array(frames);
  const lowOnset = new Float64Array(frames);
  const bands: Float64Array[] = [];
  const rms = new Float64Array(frames);
  let prev = new Float64Array(bins);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = 0; i < N_FFT; i++) {
      const x = pcm[f * HOP + i] ?? 0;
      e += x * x;
      re[i] = x * win[i]!;
      im[i] = 0;
    }
    rms[f] = Math.sqrt(e / N_FFT);
    fft(re, im);
    const mag = new Float64Array(bins);
    let flux = 0;
    let low = 0;
    for (let k = 0; k < bins; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k]!, im[k]!));
      const d = mag[k]! - prev[k]!;
      if (d > 0) {
        flux += d;
        if (k <= lowBin) low += d;
      }
    }
    onset[f] = flux;
    lowOnset[f] = low;
    const bandv = new Float64Array(N_BANDS);
    for (let b = 0; b < N_BANDS; b++) {
      let s = 0;
      for (let k = edges[b]!; k < Math.max(edges[b]! + 1, edges[b + 1]!); k++) s += mag[k] ?? 0;
      bandv[b] = s / Math.max(1, edges[b + 1]! - edges[b]!);
    }
    bands.push(bandv);
    prev = mag;
  }
  return { onset: normalizeEnvelope(onset), lowOnset: normalizeEnvelope(lowOnset), bands, rms, frames };
}

/** Subtract a moving average (≈0.5 s), half-wave rectify, scale to unit std. */
function normalizeEnvelope(x: Float64Array): Float64Array {
  const w = Math.round((0.5 * ANALYSIS_SR) / HOP);
  const out = new Float64Array(x.length);
  let acc = 0;
  const q: number[] = [];
  for (let i = 0; i < x.length; i++) {
    q.push(x[i]!);
    acc += x[i]!;
    if (q.length > w) acc -= q.shift()!;
    out[i] = Math.max(0, x[i]! - acc / q.length);
  }
  let m = 0;
  for (const v of out) m += v * v;
  const sd = Math.sqrt(m / Math.max(1, out.length)) || 1;
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / sd;
  return out;
}

/** Tempo in BPM from envelope autocorrelation with a log-normal prior (σ = 1 octave) at 120 BPM. */
export function estimateTempo(onset: Float64Array, hopSec: number): { bpm: number; confidence: number } {
  const minLag = Math.floor(60 / 200 / hopSec);
  const maxLag = Math.ceil(60 / 55 / hopSec);
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < onset.length; i++) s += onset[i]! * onset[i - lag]!;
    ac[lag] = s / (onset.length - lag);
  }
  let best = minLag;
  let bestScore = -Infinity;
  let sum = 0;
  let count = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hopSec);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120), 2));
    const score = ac[lag]! * prior;
    sum += score;
    count++;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // Parabolic refinement of the peak lag.
  const a = ac[best - 1]!;
  const b = ac[best]!;
  const c = ac[best + 1]!;
  const shift = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  const lag = best + Math.max(-0.5, Math.min(0.5, shift));
  const mean = sum / Math.max(1, count);
  return { bpm: 60 / (lag * hopSec), confidence: Math.max(0, Math.min(1, (bestScore - mean) / (bestScore || 1))) };
}

/** Dynamic-programming beat tracker (Ellis 2007). Returns beat frame indices. */
export function trackBeats(onset: Float64Array, periodFrames: number, tightness = 100): number[] {
  const n = onset.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(periodFrames / 2);
  const hi = Math.round(periodFrames * 2);
  for (let t = 0; t < n; t++) {
    let bestV = 0;
    let bestP = -1;
    for (let p = t - hi; p <= t - lo; p++) {
      if (p < 0) continue;
      const v = score[p]! - tightness * Math.pow(Math.log((t - p) / periodFrames), 2);
      if (bestP < 0 || v > bestV) {
        bestV = v;
        bestP = p;
      }
    }
    score[t] = onset[t]! + (bestP >= 0 ? Math.max(0, bestV) : 0);
    back[t] = bestP >= 0 && bestV > 0 ? bestP : -1;
  }
  // Start from the best-scoring frame in the final period.
  let t = n - 1;
  let bestEnd = -Infinity;
  for (let i = Math.max(0, n - Math.round(periodFrames)); i < n; i++) {
    if (score[i]! > bestEnd) {
      bestEnd = score[i]!;
      t = i;
    }
  }
  const beats: number[] = [];
  while (t >= 0) {
    beats.push(t);
    t = back[t]!;
  }
  return beats.reverse();
}

/** Full analysis of mono PCM at ANALYSIS_SR. */
export function analyzePcm(pcm: Float32Array): MusicAnalysis {
  const hopSec = HOP / ANALYSIS_SR;
  const durationSec = pcm.length / ANALYSIS_SR;
  const f = features(pcm);
  // Frame timestamps refer to the analysis window centre.
  const tOf = (frame: number) => Math.max(0, (frame * HOP + N_FFT / 2) / ANALYSIS_SR - hopSec);
  const { bpm, confidence } = estimateTempo(f.onset, hopSec);
  const period = 60 / bpm / hopSec;
  const beatFrames = trackBeats(f.onset, period);
  // Trim leading/trailing beats in silence (no audible energy around them).
  const maxRms = Math.max(...f.rms);
  const audible = (fr: number) => f.rms[Math.min(f.frames - 1, fr)]! > maxRms * 0.02;
  const beatsF = beatFrames.filter((b) => audible(b) || audible(b + 4));
  const beats = beatsF.map((b) => round3(tOf(b)));

  // Downbeat phase (4/4 assumed): combine three normalised cues per beat — low-band (kick)
  // onset, overall onset, and spectral change from the previous beat (chords and bass
  // tend to change on bar lines). The bar position with the highest mean wins.
  const beatBands = beatsF.map((b0, i) => {
    const b1 = beatsF[i + 1] ?? Math.min(f.frames, b0 + Math.round(period));
    const v = new Array(N_BANDS).fill(0);
    for (let fr = b0; fr < b1; fr++) for (let j = 0; j < N_BANDS; j++) v[j] += f.bands[fr]![j]! / Math.max(1, b1 - b0);
    return v;
  });
  const cues = [
    beatsF.map((b0) => windowMax(f.lowOnset, b0, 3)),
    beatsF.map((b0) => windowMax(f.onset, b0, 3)),
    beatBands.map((v, i) => (i === 0 ? 0 : Math.sqrt(v.reduce((acc, x, j) => acc + (x - beatBands[i - 1]![j]) ** 2, 0)))),
  ].map((c) => {
    const m = c.reduce((x, y) => x + y, 0) / Math.max(1, c.length);
    const sd = Math.sqrt(c.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, c.length)) || 1;
    return c.map((x) => (x - m) / sd);
  });
  let phase = 0;
  let bestPhase = -Infinity;
  for (let ph = 0; ph < 4; ph++) {
    let s = 0;
    let n = 0;
    for (let i = ph; i < beatsF.length; i += 4) {
      s += cues[0]![i]! + 0.5 * cues[1]![i]! + cues[2]![i]!;
      n++;
    }
    if (n && s / n > bestPhase) {
      bestPhase = s / n;
      phase = ph;
    }
  }
  const downIdx: number[] = [];
  for (let i = phase; i < beatsF.length; i += 4) downIdx.push(i);
  const downbeats = downIdx.map((i) => beats[i]!);

  // Per-bar features: mean band energies + loudness, z-normalised per dimension. A pickup
  // before the first downbeat (≥ half a bar) counts as its own bar starting at 0.
  const bars: number[][] = [];
  const barStartsF = downIdx.map((i) => beatsF[i]!);
  if (barStartsF.length && tOf(barStartsF[0]!) >= (2 * 60) / bpm) {
    barStartsF.unshift(0);
    downbeats.unshift(0);
  }
  for (let k = 0; k < barStartsF.length; k++) {
    const a = barStartsF[k]!;
    const b = k + 1 < barStartsF.length ? barStartsF[k + 1]! : Math.min(f.frames, a + Math.round(period * 4));
    // Features: band energies, onset density, low-band (kick) density, loudness (last).
    const v = new Array(N_BANDS + 3).fill(0);
    let n = 0;
    for (let fr = a; fr < b && fr < f.frames; fr++) {
      for (let j = 0; j < N_BANDS; j++) v[j] += f.bands[fr]![j]!;
      v[N_BANDS] += f.onset[fr]!;
      v[N_BANDS + 1] += f.lowOnset[fr]!;
      v[N_BANDS + 2] += 20 * Math.log10(f.rms[fr]! + 1e-6);
      n++;
    }
    bars.push(v.map((x) => x / Math.max(1, n)));
  }
  const sections = segmentBars(bars, downbeats, durationSec);
  return { version: MUSIC_ANALYSIS_VERSION, durationSec: round3(durationSec), bpm: Math.round(bpm * 100) / 100, tempoConfidence: Math.round(confidence * 100) / 100, beats, downbeats, sections, hopSec };
}

function windowMax(x: Float64Array, i: number, r: number) {
  let m = 0;
  for (let k = Math.max(0, i - r); k <= Math.min(x.length - 1, i + r); k++) m = Math.max(m, x[k]!);
  return m;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Checkerboard novelty over a bar self-similarity matrix; boundaries on bar lines. */
function segmentBars(bars: number[][], downbeats: number[], durationSec: number): MusicAnalysis["sections"] {
  const n = bars.length;
  if (n < 4) return [{ startSec: 0, endSec: durationSec, label: "section", energy: 1 }];
  const dims = bars[0]!.length;
  const mean = new Array(dims).fill(0);
  const sd = new Array(dims).fill(0);
  for (const b of bars) b.forEach((x, j) => (mean[j] += x / n));
  for (const b of bars) b.forEach((x, j) => (sd[j] += (x - mean[j]) ** 2 / n));
  const z = bars.map((b) => b.map((x, j) => (x - mean[j]) / (Math.sqrt(sd[j]) || 1)));
  const dist = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, x, j) => s + (x - b[j]!) ** 2, 0) / dims);
  const sim = (i: number, j: number) => Math.exp(-dist(z[i]!, z[j]!));
  const L = Math.min(4, Math.floor(n / 4));
  const nov = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    let s = 0;
    let cnt = 0;
    for (let a = -L; a < L; a++) {
      for (let b = -L; b < L; b++) {
        const ia = i + a;
        const ib = i + b;
        if (ia < 0 || ib < 0 || ia >= n || ib >= n) continue;
        const sign = (a < 0) === (b < 0) ? 1 : -1;
        s += sign * sim(ia, ib);
        cnt++;
      }
    }
    // Normalise by the full kernel so partial kernels at the edges don't inflate novelty.
    nov[i] = cnt ? s / (4 * L * L) : 0;
  }
  // Peaks: local maxima within ±2 bars, above 35% of the strongest interior peak.
  const top = Math.max(...nov.slice(2, Math.max(3, n - 2)), 1e-9);
  const cands = nov
    .map((v, i) => ({ v, i }))
    .filter(({ v, i }) => i > 1 && i < n - 1 && v > 0.35 * top && nov.slice(Math.max(0, i - 2), i + 3).every((x) => x <= v));
  cands.sort((a, b) => b.v - a.v);
  const chosen: number[] = [];
  const minBars = 2;
  for (const c of cands) if (chosen.every((x) => Math.abs(x - c.i) >= minBars)) chosen.push(c.i);
  chosen.sort((a, b) => a - b);
  const starts = [0, ...chosen];
  const segs = starts.map((b, k) => {
    const e = k + 1 < starts.length ? starts[k + 1]! : n;
    const startSec = k === 0 ? 0 : downbeats[b]!;
    const endSec = k + 1 < starts.length ? downbeats[e]! : durationSec;
    const feat = new Array(dims).fill(0);
    for (let i = b; i < e; i++) z[i]!.forEach((x, j) => (feat[j] += x / (e - b)));
    const energy = bars.slice(b, e).reduce((a, x) => a + x[dims - 1]!, 0) / (e - b);
    return { startSec: round3(startSec), endSec: round3(endSec), feat, energy };
  });
  // Labels (proposals): quiet unique edges are intro/outro; interior sections split into a
  // high and a low energy tier — chorus/verse when a tier repeats, peak/build otherwise.
  const eMin = Math.min(...segs.map((s) => s.energy));
  const eMax = Math.max(...segs.map((s) => s.energy));
  const norm = (e: number) => (e - eMin) / (eMax - eMin || 1);
  const edge = (i: number) => segs.length > 2 && (i === 0 ? norm(segs[0]!.energy) < norm(segs[1]!.energy) : i === segs.length - 1 ? norm(segs[i]!.energy) < norm(segs[i - 1]!.energy) : false);
  const interior = segs.map((_, i) => i).filter((i) => !edge(i));
  const iMin = Math.min(...interior.map((i) => segs[i]!.energy));
  const iMax = Math.max(...interior.map((i) => segs[i]!.energy));
  const high = (i: number) => iMax - iMin > 0.5 && segs[i]!.energy >= (iMin + iMax) / 2;
  const nHigh = interior.filter(high).length;
  const nLow = interior.length - nHigh;
  const labelOf = (i: number) => (edge(i) ? (i === 0 ? "intro" : "outro") : iMax - iMin <= 0.5 ? "section" : high(i) ? (nHigh > 1 ? "chorus" : "peak") : nLow > 1 ? "verse" : "build");
  return segs.map((s, i) => ({ startSec: s.startSec, endSec: s.endSec, label: labelOf(i), energy: Math.round(norm(s.energy) * 100) / 100 }));
}

export async function analyzeMusicFile(file: string): Promise<MusicAnalysis> {
  return analyzePcm(await decodeMono(file));
}
