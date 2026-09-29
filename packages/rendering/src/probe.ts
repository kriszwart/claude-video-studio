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
