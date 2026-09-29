import { access } from "node:fs/promises";
import { resolveChromePath, RENDERER_VERSIONS, run } from "@vs/rendering";

/** Record what this worker can actually do (FR-21): a client preview working proves nothing here. */
export async function workerCapabilities() {
  const has = async (p: string) => access(p).then(() => true).catch(() => false);
  const ffmpeg = await run(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-encoders"]).catch(() => null);
  const chrome = await resolveChromePath();
  return {
    renderer: RENDERER_VERSIONS,
    chrome: chrome ?? null,
    ffmpeg: { available: !!ffmpeg, libx264: !!ffmpeg?.stdout.includes("libx264"), aac: !!ffmpeg?.stdout.includes(" aac ") },
    tts: { pico: await has("/usr/bin/pico2wave"), espeak: await has("/usr/bin/espeak-ng") },
    transcription: { pocketsphinx: await has("/usr/bin/pocketsphinx_continuous") },
    graphics: { skia: false, redraw: false },
    gpu: "software",
  };
}
