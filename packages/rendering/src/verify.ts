import { FFMPEG, run } from "./exec";
import { measureLoudness } from "./mix";
import { probeMedia, type MediaProbe } from "./probe";

export interface VerifyExpectation {
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  requireAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Review signals are surfaced but never fail a job on their own. */
  severity: "hard" | "signal";
}

export interface VerificationReport {
  ok: boolean;
  checks: VerifyCheck[];
  probe: MediaProbe;
  decodedFrames: number | null;
  loudness: { lufs: number; truePeakDb: number; lra: number } | null;
  blackSegments: { start: number; end: number }[];
  silentSegments: { start: number; end: number }[];
  verifiedAt: string;
}

/**
 * FR-10: a job is only successful when the file decodes completely, has the expected
 * streams and dimensions, and matches the scheduled duration within one frame.
 */
export async function verifyVideo(file: string, exp: VerifyExpectation, signal?: AbortSignal): Promise<VerificationReport> {
  const checks: VerifyCheck[] = [];
  const probe = await probeMedia(file);
  const v = probe.video;
  checks.push({ name: "video_stream", ok: !!v, detail: v ? `${v.codec} ${v.width}x${v.height} @ ${v.fps?.toFixed(3)}` : "no video stream", severity: "hard" });
  if (v) {
    checks.push({ name: "video_codec", ok: v.codec === (exp.videoCodec ?? "h264"), detail: v.codec, severity: "hard" });
    checks.push({ name: "dimensions", ok: v.width === exp.width && v.height === exp.height, detail: `${v.width}x${v.height} (expected ${exp.width}x${exp.height})`, severity: "hard" });
    checks.push({ name: "frame_rate", ok: v.fps !== null && Math.abs(v.fps - exp.fps) < 0.01, detail: `${v.fps}`, severity: "hard" });
  }
  const a = probe.audio;
  if (exp.requireAudio) {
    checks.push({ name: "audio_stream", ok: !!a && a.codec === (exp.audioCodec ?? "aac"), detail: a ? `${a.codec} ${a.sampleRate}Hz ${a.channels}ch` : "no audio stream", severity: "hard" });
  }

  // Full decode, counting frames and collecting black/silence review signals.
  const args = ["-hide_banner", "-nostdin", "-v", "info", "-i", file, "-map", "0:v:0", "-vf", "blackdetect=d=0.5:pix_th=0.06"];
  if (a) args.push("-map", "0:a:0", "-af", "silencedetect=n=-55dB:d=1.5");
  args.push("-f", "null", "-");
  const dec = await run(FFMPEG, args, { signal, timeoutMs: 900_000 });
  const decodeOk = dec.code === 0 && !/Error while decoding|Invalid data found|corrupt/i.test(dec.stderr);
  checks.push({ name: "full_decode", ok: decodeOk, detail: decodeOk ? "decoded without errors" : dec.stderr.slice(-400), severity: "hard" });
  const frameMatches = [...dec.stderr.matchAll(/frame=\s*(\d+)/g)];
  const decodedFrames = frameMatches.length ? Number(frameMatches.at(-1)![1]) : null;
  if (decodedFrames !== null) {
    const diff = Math.abs(decodedFrames - exp.totalFrames);
    checks.push({ name: "duration_frames", ok: diff <= 1, detail: `${decodedFrames} frames (expected ${exp.totalFrames}, ±1)`, severity: "hard" });
  } else {
    checks.push({ name: "duration_frames", ok: false, detail: "could not count decoded frames", severity: "hard" });
  }
  if (a && a.durationSec !== null) {
    const expected = exp.totalFrames / exp.fps;
    // AAC priming/padding adds up to ~2 frames of audio; allow one video frame plus 50 ms.
    const ok = Math.abs(a.durationSec - expected) <= 1 / exp.fps + 0.05;
    checks.push({ name: "audio_duration", ok, detail: `${a.durationSec.toFixed(3)}s (timeline ${expected.toFixed(3)}s)`, severity: exp.requireAudio ? "hard" : "signal" });
  }

  const blackSegments = [...dec.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
  const silenceStarts = [...dec.stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const silenceEnds = [...dec.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const silentSegments = silenceStarts.map((s, i) => ({ start: s, end: silenceEnds[i] ?? exp.totalFrames / exp.fps }));
  if (blackSegments.length) {
    checks.push({ name: "black_frames", ok: true, detail: `review: ${blackSegments.map((b) => `${b.start.toFixed(2)}–${b.end.toFixed(2)}s`).join(", ")}`, severity: "signal" });
  }
  if (silentSegments.length && exp.requireAudio) {
    checks.push({ name: "silence", ok: true, detail: `review: ${silentSegments.map((b) => `${b.start.toFixed(2)}–${b.end.toFixed(2)}s`).join(", ")}`, severity: "signal" });
  }

  const loudness = a ? await measureLoudness(file, signal).catch(() => null) : null;
  if (loudness && exp.requireAudio) {
    checks.push({ name: "true_peak", ok: loudness.truePeakDb <= -1.0, detail: `${loudness.truePeakDb.toFixed(1)} dBTP, ${loudness.lufs.toFixed(1)} LUFS integrated`, severity: "signal" });
  }

  return {
    ok: checks.filter((c) => c.severity === "hard").every((c) => c.ok),
    checks,
    probe,
    decodedFrames,
    loudness,
    blackSegments,
    silentSegments,
    verifiedAt: new Date().toISOString(),
  };
}

/** Extract one frame as PNG/JPEG (thumbnails, storyboard keyframes, QA evidence). */
export async function extractFrame(file: string, timeSec: number, out: string, width?: number): Promise<void> {
  const vf = width ? ["-vf", `scale=${width}:-2`] : [];
  const r = await run(FFMPEG, ["-hide_banner", "-nostdin", "-y", "-ss", timeSec.toFixed(3), "-i", file, "-frames:v", "1", ...vf, out], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`frame extraction failed: ${r.stderr.slice(-300)}`);
}
