import { access } from "node:fs/promises";
import { graphicsCapabilities } from "@vs/graphics";
import { LocalTts } from "@vs/providers";
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
    tts: { pico: await has("/usr/bin/pico2wave"), espeak: await has("/usr/bin/espeak-ng"), voices: await new LocalTts().voices() },
    transcription: { pocketsphinx: await has("/usr/bin/pocketsphinx_continuous") },
    graphics: await (async () => {
      const g = await graphicsCapabilities();
      return { skia: g.skia.available, redraw: g.redraw.available, skiaVersion: g.skia.version, redrawVersion: g.redraw.version, redrawChecksum: g.redraw.checksum, redrawReason: g.redraw.reason ?? null, webgpu: "software adapter via --enable-unsafe-webgpu (no hardware GPU detected)" };
    })(),
    gpu: "software",
  };
}
