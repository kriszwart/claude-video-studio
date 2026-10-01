import { JobError } from "@vs/db";

const BROWSER_FIX =
  "Install the render browser with `pnpm exec playwright-core install chromium-headless-shell`, set HYPERFRAMES_CHROME_PATH in .env to its chrome-headless-shell (or headless_shell) binary, then restart the worker.";

/**
 * Setup problems on the worker machine (missing tools, an unsuitable render browser, a full
 * disk). Retrying cannot fix them, so they fail at once with what is wrong and how to fix it,
 * instead of the generic "internal error" after several attempts. Anything else returns null.
 */
export function classifyEnvironmentError(e: unknown): JobError | null {
  if (!(e instanceof Error)) return null;
  const code = (e as { code?: unknown }).code;
  const path = String((e as { path?: unknown }).path ?? "");
  const msg = e.message;

  if (e.name === "SwiftShaderAssertionError" || code === "BROWSER_GPU_NOT_SOFTWARE") {
    return new JobError("renderer_browser", "The render browser cannot draw graphics in software mode (WebGL through SwiftShader), which video rendering needs.", false, BROWSER_FIX);
  }
  if (/Failed to launch .*executable doesn't exist|Browser was not found|Could not find (Chrome|Chromium)/i.test(msg) || (code === "ENOENT" && /chrom|headless_shell/i.test(path))) {
    return new JobError("renderer_browser_missing", "The render browser was not found on this computer.", false, BROWSER_FIX);
  }
  if (code === "ENOENT" && /(^|\/)ff(mpeg|probe)$/.test(path)) {
    return new JobError("ffmpeg_missing", "FFmpeg is not installed on this computer, or the worker cannot find it.", false, "Install it (`brew install ffmpeg` on a Mac, `sudo apt install ffmpeg` on Linux) or set FFMPEG_BIN in .env, then restart the worker.");
  }
  if (code === "ENOSPC" || /no space left on device/i.test(msg)) {
    return new JobError("disk_full", "The disk is full, so the worker could not write its files.", false, "Free up disk space (old renders live in the data folder), then retry.");
  }
  return null;
}
