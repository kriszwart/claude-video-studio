import { z } from "zod";

export const AspectRatio = z.enum(["16:9", "9:16", "1:1"]);
export type AspectRatio = z.infer<typeof AspectRatio>;

/** Baseline final presets from FR-10. Drafts scale these down but keep the timing model. */
export const FINAL_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

export const OutputFormat = z.object({
  aspect: AspectRatio,
  fps: z.literal(30),
});
export type OutputFormat = z.infer<typeof OutputFormat>;

export function dimensionsFor(aspect: AspectRatio, scale = 1): { width: number; height: number } {
  const d = FINAL_DIMENSIONS[aspect];
  // Encoders need even dimensions.
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(d.width), height: even(d.height) };
}

/**
 * Seconds → frames. Rounding is explicit: nearest frame, ties away from zero.
 * Source media boundaries keep seconds; only timeline positions are frames.
 */
export function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps;
}

/** Safe-area presets (fractions of width/height). Versioned because platform overlays change (T4). */
export const SAFE_AREA_PRESETS = {
  "none@1": { top: 0.04, bottom: 0.04, left: 0.04, right: 0.04, label: "Title safe (4%)" },
  "reels-shorts@2026-09": {
    top: 0.1,
    bottom: 0.2,
    left: 0.05,
    right: 0.14,
    label: "Vertical social (conservative, 2026-09)",
  },
} as const;
export type SafeAreaPresetId = keyof typeof SAFE_AREA_PRESETS;
export const SafeAreaPresetIdSchema = z.enum(["none@1", "reels-shorts@2026-09"]);

/**
 * Sizes to export in one go: the requested ones in order without repeats, or just the project's
 * own size when none are requested. The project's size is listed first when it is requested.
 */
export function exportSizes(projectAspect: AspectRatio, requested?: AspectRatio[]): AspectRatio[] {
  const wanted = [...new Set(requested ?? [])];
  if (!wanted.length) return [projectAspect];
  return wanted.includes(projectAspect) ? [projectAspect, ...wanted.filter((a) => a !== projectAspect)] : wanted;
}
