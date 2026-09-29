import { FFMPEG, runOk } from "./exec";

export interface MixInput {
  id: string;
  kind: "music" | "voiceover" | "source" | "sfx";
  file: string;
  /** Absolute timeline placement. */
  startFrame: number;
  durationFrames: number;
  sourceInSec: number;
  gainDb: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  duck?: { enabled: boolean; amountDb: number };
}

export interface MixOptions {
  fps: number;
  totalFrames: number;
  output: string;
  /** Integrated loudness target and true-peak ceiling (FR-09 defaults). */
  targetLufs?: number;
  truePeakDb?: number;
  /** Ramp length for ducking, seconds. */
  duckRampSec?: number;
  signal?: AbortSignal;
}

export interface MixReport {
  tracks: number;
  speechIntervals: [number, number][];
  target: { lufs: number; truePeakDb: number };
  measuredBefore?: { lufs: number; truePeakDb: number; lra: number };
  measuredAfter?: { lufs: number; truePeakDb: number; lra: number };
  silent: boolean;
}

const f = (n: number) => Number(n.toFixed(4));

/** Merge speech intervals that are closer than `gap` seconds. */
export function mergeIntervals(ivs: [number, number][], gap: number): [number, number][] {
  const sorted = [...ivs].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const iv of sorted) {
    const last = out.at(-1);
    if (last && iv[0] <= last[1] + gap) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/**
 * Ducking gain expression: 1 outside speech, `duckGain` inside, linear ramps of `r`
 * seconds. Intervals are merged so trapezoids never overlap (sum ≤ 1).
 */
export function duckExpression(intervals: [number, number][], duckGain: number, r: number): string {
  if (intervals.length === 0) return "1";
  const traps = intervals.map(([a, b]) => `clip((t-${f(a - r)})/${f(r)},0,1)*clip((${f(b + r)}-t)/${f(r)},0,1)`);
  // Chunk the sum to keep expressions parseable for long programs.
  const env = traps.length > 1 ? `min(1,${traps.join("+")})` : traps[0]!;
  return `1-${f(1 - duckGain)}*(${env})`;
}

export async function mixAudio(inputs: MixInput[], opts: MixOptions): Promise<MixReport> {
  const fps = opts.fps;
  const total = opts.totalFrames / fps;
  const target = { lufs: opts.targetLufs ?? -16, truePeakDb: opts.truePeakDb ?? -1 };
  const ramp = opts.duckRampSec ?? 0.25;
  const valid = inputs.filter((i) => i.durationFrames > 0);

  const speech = mergeIntervals(
    valid.filter((i) => i.kind === "voiceover" || i.kind === "source").map((i) => [i.startFrame / fps, (i.startFrame + i.durationFrames) / fps] as [number, number]),
    ramp * 2,
  );

  const pre = opts.output.replace(/\.wav$/, "") + ".pre.wav";
  const args: string[] = ["-hide_banner", "-nostdin", "-y"];
  const filters: string[] = [];
  if (valid.length === 0) {
    args.push("-f", "lavfi", "-t", String(f(total)), "-i", "anullsrc=r=48000:cl=stereo", "-c:a", "pcm_s16le", opts.output);
    await runOk(FFMPEG, args, { signal: opts.signal, timeoutMs: 120_000 });
    return { tracks: 0, speechIntervals: [], target, silent: true };
  }

  valid.forEach((inp, i) => {
    args.push("-i", inp.file);
    const dur = inp.durationFrames / fps;
    const start = inp.startFrame / fps;
    const chain = [
      `atrim=start=${f(inp.sourceInSec)}:duration=${f(dur)}`,
      "asetpts=PTS-STARTPTS",
      "aresample=48000",
      "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
      // Pad short media so fades land on the intended timeline position.
      `apad=whole_dur=${f(dur)}`,
      `volume=${f(inp.gainDb)}dB`,
    ];
    if (inp.fadeInFrames > 0) chain.push(`afade=t=in:st=0:d=${f(inp.fadeInFrames / fps)}`);
    if (inp.fadeOutFrames > 0) chain.push(`afade=t=out:st=${f(Math.max(0, dur - inp.fadeOutFrames / fps))}:d=${f(inp.fadeOutFrames / fps)}`);
    chain.push(`adelay=delays=${Math.round(start * 1000)}:all=1`);
    if (inp.kind === "music" && inp.duck?.enabled && speech.length > 0) {
      const g = Math.pow(10, inp.duck.amountDb / 20);
      chain.push(`volume='${duckExpression(speech, g, ramp)}':eval=frame`);
    }
    filters.push(`[${i}:a]${chain.join(",")}[a${i}]`);
  });
  const labels = valid.map((_, i) => `[a${i}]`).join("");
  filters.push(`${labels}amix=inputs=${valid.length}:normalize=0:duration=longest,apad=whole_dur=${f(total)},atrim=0:${f(total)}[mix]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[mix]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_f32le", pre);
  await runOk(FFMPEG, args, { signal: opts.signal, timeoutMs: 600_000 });

  // Pass 1: measure.
  const m1 = await runOk(
    FFMPEG,
    ["-hide_banner", "-nostdin", "-i", pre, "-af", `loudnorm=I=${target.lufs}:TP=${target.truePeakDb - 1}:LRA=11:print_format=json`, "-f", "null", "-"],
    { signal: opts.signal, timeoutMs: 600_000 },
  );
  const before = parseLoudnorm(m1.stderr);
  if (!before || !Number.isFinite(before.input_i) || before.input_i < -70) {
    // Effectively silent content: loudnorm would amplify noise. Keep as-is.
    await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-y", "-i", pre, "-c:a", "pcm_s16le", opts.output], { signal: opts.signal });
    return { tracks: valid.length, speechIntervals: speech, target, silent: true };
  }
  // Pass 2: linear normalisation with measured values (no pumping), then a true-peak limiter.
  // AAC encoding overshoots inter-sample peaks by up to ~0.5–1 dB, so the PCM mix
  // keeps 1 dB of extra headroom below the delivered true-peak ceiling.
  const pcmCeiling = target.truePeakDb - 1;
  const ln = `loudnorm=I=${target.lufs}:TP=${pcmCeiling}:LRA=11:measured_I=${before.input_i}:measured_TP=${before.input_tp}:measured_LRA=${before.input_lra}:measured_thresh=${before.input_thresh}:offset=${before.target_offset}:linear=true:print_format=json`;
  await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-y", "-i", pre, "-af", `${ln},aresample=48000`, "-ar", "48000", "-c:a", "pcm_s16le", opts.output], {
    signal: opts.signal,
    timeoutMs: 600_000,
  });
  const after = await measureLoudness(opts.output, opts.signal);
  return {
    tracks: valid.length,
    speechIntervals: speech,
    target,
    measuredBefore: { lufs: before.input_i, truePeakDb: before.input_tp, lra: before.input_lra },
    measuredAfter: after ?? undefined,
    silent: false,
  };
}

interface LoudnormJson {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

function parseLoudnorm(stderr: string): LoudnormJson | null {
  const m = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!m) return null;
  const j = JSON.parse(m[0]) as Record<string, string>;
  const n = (k: string) => Number(j[k]);
  return { input_i: n("input_i"), input_tp: n("input_tp"), input_lra: n("input_lra"), input_thresh: n("input_thresh"), target_offset: n("target_offset") };
}

/** EBU R128 integrated loudness and true peak of a file's audio. */
export async function measureLoudness(file: string, signal?: AbortSignal): Promise<{ lufs: number; truePeakDb: number; lra: number } | null> {
  const r = await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"], { signal, timeoutMs: 600_000 });
  const summary = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const i = summary.match(/I:\s+(-?[\d.]+|-inf) LUFS/);
  const lra = summary.match(/LRA:\s+(-?[\d.]+) LU/);
  const peak = summary.match(/True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/);
  if (!i) return null;
  const num = (s: string | undefined) => (s === undefined || s === "-inf" ? -Infinity : Number(s));
  return { lufs: num(i[1]), truePeakDb: num(peak?.[1]), lra: num(lra?.[1]) };
}
