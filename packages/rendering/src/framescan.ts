import { spawn } from "node:child_process";
import { FFMPEG } from "./exec";

/**
 * Frame-to-frame checks on a rendered file, on small greyscale frames (64×36 by default):
 *  - glitch scan: a frame that differs from both neighbours while they match each other (a
 *    one-frame flash: something drawn for a single frame), or a jump far bigger than the motion
 *    around it inside a scene (a re-centring, a layer popping in without an entrance);
 *  - loop check: whether the last frame matches the first, so a looping video has no visible seam.
 * Differences are judged per cell of a 4×4 grid, so a small element that pops still registers.
 */

export interface GreyFrames {
  width: number;
  height: number;
  fps: number;
  frames: Uint8Array[];
}

const W = 64;
const H = 36;
const GRID = 4;

/** Decode a video to small greyscale frames. */
export async function greyFrames(file: string, fps: number, signal?: AbortSignal): Promise<GreyFrames> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-vf", `scale=${W}:${H}:flags=area,format=gray`, "-f", "rawvideo", "-"], { signal });
    let err = "";
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.stderr.on("data", (c: Buffer) => (err += c.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`frame decode failed: ${err.slice(-300)}`))));
  });
  const all = Buffer.concat(chunks);
  const size = W * H;
  const frames: Uint8Array[] = [];
  for (let o = 0; o + size <= all.length; o += size) frames.push(new Uint8Array(all.buffer, all.byteOffset + o, size));
  return { width: W, height: H, fps, frames };
}

/** Largest mean absolute difference over the cells of a GRID×GRID split (0–255). */
export function cellDiff(a: Uint8Array, b: Uint8Array, width = W, height = H): number {
  const cw = width / GRID, ch = height / GRID;
  let worst = 0;
  for (let gy = 0; gy < GRID; gy++)
    for (let gx = 0; gx < GRID; gx++) {
      let sum = 0, n = 0;
      for (let y = Math.floor(gy * ch); y < Math.floor((gy + 1) * ch); y++)
        for (let x = Math.floor(gx * cw); x < Math.floor((gx + 1) * cw); x++) {
          const i = y * width + x;
          sum += Math.abs(a[i]! - b[i]!);
          n++;
        }
      if (n && sum / n > worst) worst = sum / n;
    }
  return worst;
}

export interface FrameGlitch {
  kind: "flash" | "jump";
  frame: number;
  timeSec: number;
  /** Cell difference at the glitch, and what the motion around it measured. */
  diff: number;
  around: number;
}

/** A one-frame flash: frame i differs from both neighbours by at least this much… */
export const FLASH_MIN = 10;
/** …while the neighbours differ from each other by at most this share of it. */
export const FLASH_RETURN = 0.35;
/** A jump: at least this much change in one frame… */
export const JUMP_MIN = 28;
/** …and this many times the typical frame-to-frame change around it. */
export const JUMP_RATIO = 8;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/**
 * Find glitches (pure). `cuts` are frame numbers where a change is expected (scene starts,
 * edits inside a recording); jumps within 2 frames of one are ignored. `skipJumps(frame)` lets
 * the caller ignore stretches where big frame-to-frame change is normal (camera footage).
 */
export function findGlitches(g: GreyFrames, cuts: number[] = [], skipJumps: (frame: number) => boolean = () => false): FrameGlitch[] {
  const f = g.frames;
  const d: number[] = [];
  for (let i = 1; i < f.length; i++) d.push(cellDiff(f[i - 1]!, f[i]!, g.width, g.height)); // d[i-1]: frame i-1 → i
  const out: FrameGlitch[] = [];
  const nearCut = (i: number) => cuts.some((c) => Math.abs(c - i) <= 2);
  for (let i = 1; i < f.length - 1; i++) {
    const a = d[i - 1]!, b = d[i]!;
    if (a >= FLASH_MIN && b >= FLASH_MIN) {
      const across = cellDiff(f[i - 1]!, f[i + 1]!, g.width, g.height);
      if (across <= FLASH_RETURN * Math.min(a, b)) {
        out.push({ kind: "flash", frame: i, timeSec: round(i / g.fps), diff: round(Math.min(a, b)), around: round(across) });
        continue;
      }
    }
  }
  for (let i = 1; i < f.length; i++) {
    const a = d[i - 1]!;
    if (a < JUMP_MIN || nearCut(i) || skipJumps(i) || out.some((o) => Math.abs(o.frame - i) <= 1)) continue;
    const local = median([...d.slice(Math.max(0, i - 9), i - 1), ...d.slice(i, i + 8)]);
    if (a >= JUMP_RATIO * Math.max(local, 0.5)) out.push({ kind: "jump", frame: i, timeSec: round(i / g.fps), diff: round(a), around: round(local) });
  }
  return out.sort((x, y) => x.frame - y.frame);
}

/** Loops: the last frame should match the first. Returns the cell difference (0 = identical). */
export function loopSeam(g: GreyFrames): number {
  if (g.frames.length < 2) return 0;
  return round(cellDiff(g.frames[0]!, g.frames[g.frames.length - 1]!, g.width, g.height));
}
/** Below this the seam is invisible (encoder noise). */
export const LOOP_SEAM_MAX = 3;

const round = (x: number) => Math.round(x * 100) / 100;
