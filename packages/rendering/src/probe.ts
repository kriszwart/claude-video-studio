import { FFMPEG, run as runBin } from "./exec";
import { FFPROBE, runOk } from "./exec";

export interface MediaProbe {
  container: string;
  durationSec: number | null;
  video?: { codec: string; width: number; height: number; fps: number | null; frames: number | null; pixFmt: string | null };
  audio?: { codec: string; sampleRate: number; channels: number; durationSec: number | null };
  hasAlpha: boolean;
}

function parseRate(r: string | undefined): number | null {
  if (!r || r === "0/0") return null;
  const [a, b] = r.split("/").map(Number);
  return b ? a! / b : Number(a);
}

/** Probe actual media streams (FR-08: never trust extensions). */
export async function probeMedia(path: string): Promise<MediaProbe> {
  const r = await runOk(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { timeoutMs: 60_000 });
  const j = JSON.parse(r.stdout) as { format?: { format_name?: string; duration?: string }; streams?: Array<Record<string, unknown>> };
  const streams = j.streams ?? [];
  // Cover art in audio files appears as an attached-picture video stream; it is not video.
  const v = streams.find((s) => s.codec_type === "video" && !(s.disposition as { attached_pic?: number } | undefined)?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  const fmtDur = j.format?.duration ? Number(j.format.duration) : null;
  const pix = (v?.pix_fmt as string | undefined) ?? null;
  return {
    container: j.format?.format_name ?? "unknown",
    durationSec: fmtDur !== null && Number.isFinite(fmtDur) ? fmtDur : null,
    video: v
      ? {
          codec: String(v.codec_name),
          width: Number(v.width),
          height: Number(v.height),
          fps: parseRate(v.avg_frame_rate as string) ?? parseRate(v.r_frame_rate as string),
          frames: v.nb_frames ? Number(v.nb_frames) : null,
          pixFmt: pix,
        }
      : undefined,
    audio: a
      ? { codec: String(a.codec_name), sampleRate: Number(a.sample_rate), channels: Number(a.channels), durationSec: a.duration ? Number(a.duration) : null }
      : undefined,
    hasAlpha: !!pix && /a|rgba|argb|yuva/.test(pix) && !/^yuv4[0-9]{2}p$/.test(pix),
  };
}

/**
 * Mean Rec.709 luminance (0..1) of an image's opaque pixels, sampled at 64×64. Used to give
 * logos a contrasting backing (a dark wordmark on a dark card is unreadable). Null if unknown.
 */
export async function opaqueLuma(file: string): Promise<number | null> {
  const r = await runBin(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-frames:v", "1", "-vf", "scale=64:64:flags=area,format=rgba", "-f", "rawvideo", "-"], { timeoutMs: 30_000 }).catch(() => null);
  const buf = r?.code === 0 ? r.stdoutBuffer : null;
  if (!buf || buf.length < 64 * 64 * 4) return null;
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 3 < buf.length; i += 4) {
    if (buf[i + 3]! < 128) continue;
    sum += (0.2126 * buf[i]! + 0.7152 * buf[i + 1]! + 0.0722 * buf[i + 2]!) / 255;
    n++;
  }
  return n ? Math.round((sum / n) * 1000) / 1000 : null;
}
