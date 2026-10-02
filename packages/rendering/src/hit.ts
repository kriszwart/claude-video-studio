import { spawn } from "node:child_process";
import { FFMPEG } from "./exec";

/**
 * Where a sound effect "hits": the first moment it gets close to its loudest, measured on the
 * decoded audio (5 ms windows). A click with a press and a release of similar loudness hits on
 * the press; a whoosh that swells hits near its peak. Decoding with the same ffmpeg as the mix
 * keeps any MP3 start delay consistent between measuring and mixing.
 */
export interface SoundHit {
  hitSec: number;
  /** The single loudest moment. */
  peakSec: number;
  durationSec: number;
}

const SR = 16_000;
/** A window this close to the loudest one counts as the hit. */
export const HIT_SHARE = 0.6;

export function hitFromSamples(samples: Float32Array, sampleRate = SR): SoundHit {
  const win = Math.max(1, Math.round(sampleRate * 0.005));
  const rms: number[] = [];
  for (let o = 0; o < samples.length; o += win) {
    let s = 0;
    const end = Math.min(samples.length, o + win);
    for (let i = o; i < end; i++) s += samples[i]! * samples[i]!;
    rms.push(Math.sqrt(s / Math.max(1, end - o)));
  }
  const max = Math.max(0, ...rms);
  const peak = rms.indexOf(max);
  const hit = max > 0 ? rms.findIndex((r) => r >= HIT_SHARE * max) : 0;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { hitSec: r3((hit * win) / sampleRate), peakSec: r3((peak * win) / sampleRate), durationSec: r3(samples.length / sampleRate) };
}

export async function measureHit(file: string, signal?: AbortSignal): Promise<SoundHit> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-t", "30", "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { signal });
    let err = "";
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.stderr.on("data", (c: Buffer) => (err += c.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`audio decode failed: ${err.slice(-300)}`))));
  });
  const buf = Buffer.concat(chunks);
  const n = Math.floor(buf.length / 4);
  return hitFromSamples(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4)));
}
