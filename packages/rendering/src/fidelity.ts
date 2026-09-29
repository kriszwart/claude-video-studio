import { FFMPEG, runOk } from "./exec";

/**
 * Product-fidelity signal for generated shots (A23): a hue × saturation histogram of the
 * coloured pixels (near-white, near-black and grey background ignored), compared with the
 * approved reference by histogram intersection. This is a measured colour check only — it
 * cannot confirm shape or logo placement — so a flag means "review", and a pass is not proof.
 */
const HB = 12;
const SB = 3;

export async function paletteHistogram(file: string, atSec = 0): Promise<number[]> {
  const r = await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", ...(atSec ? ["-ss", atSec.toFixed(2)] : []), "-i", file, "-frames:v", "1", "-vf", "scale=64:64:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { timeoutMs: 60_000 });
  const b = r.stdoutBuffer;
  const h = new Array<number>(HB * SB).fill(0);
  let n = 0;
  for (let i = 0; i + 2 < b.length; i += 3) {
    const R = b[i]! / 255, G = b[i + 1]! / 255, B = b[i + 2]! / 255;
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    const v = max, s = max === 0 ? 0 : (max - min) / max;
    if (s < 0.15 || v < 0.12 || v > 0.97) continue;
    let hue = 0;
    const d = max - min;
    if (max === R) hue = ((G - B) / d) % 6;
    else if (max === G) hue = (B - R) / d + 2;
    else hue = (R - G) / d + 4;
    hue = ((hue * 60) + 360) % 360;
    h[Math.min(HB - 1, Math.floor(hue / (360 / HB))) * SB + Math.min(SB - 1, Math.floor(s * SB))]! += 1;
    n++;
  }
  return n ? h.map((x) => x / n) : h;
}

export function paletteSimilarity(a: number[], b: number[]): number {
  if (!a.some(Boolean) || !b.some(Boolean)) return 0;
  return Math.round(a.reduce((acc, x, i) => acc + Math.min(x, b[i] ?? 0), 0) * 1000) / 1000;
}

export const FIDELITY_THRESHOLD = 0.35;

/** Compare a generated image/video (sampled at 3 points) with the reference photo. */
export async function productFidelity(generated: string, reference: string, durationSec?: number) {
  const ref = await paletteHistogram(reference);
  const times = durationSec ? [durationSec * 0.2, durationSec * 0.5, durationSec * 0.8] : [0];
  const sims: number[] = [];
  for (const t of times) sims.push(paletteSimilarity(await paletteHistogram(generated, t), ref));
  const similarity = Math.min(...sims);
  return { paletteSimilarity: similarity, flagged: similarity < FIDELITY_THRESHOLD, method: `hue×saturation histogram intersection (min of ${sims.length} samples), threshold ${FIDELITY_THRESHOLD}; colour only — shape and logos need human review` };
}
