import { graphicsCapabilities } from "@vs/graphics";
import { findBinary, LocalTts, WhisperCppStt } from "@vs/providers";
import { resolveChromePath, RENDERER_VERSIONS, run } from "@vs/rendering";

/** Record what this worker can actually do (FR-21): a client preview working proves nothing here. */
export async function workerCapabilities() {
  const ffmpeg = await run(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-encoders"]).catch(() => null);
  const chrome = await resolveChromePath();
  return {
    renderer: RENDERER_VERSIONS,
    chrome: chrome ?? null,
    ffmpeg: { available: !!ffmpeg, libx264: !!ffmpeg?.stdout.includes("libx264"), aac: !!ffmpeg?.stdout.includes(" aac ") },
    tts: { pico: !!(await findBinary("pico2wave")), espeak: !!(await findBinary("espeak-ng")), voices: await new LocalTts().voices() },
    transcription: { subtitleImport: true, whisperCpp: WhisperCppStt.available(), elevenlabs: "configured per workspace in Settings" },
    graphics: await (async () => {
      const g = await graphicsCapabilities();
      return { skia: g.skia.available, redraw: g.redraw.available, skiaVersion: g.skia.version, redrawVersion: g.redraw.version, redrawChecksum: g.redraw.checksum, redrawReason: g.redraw.reason ?? null, webgpu: "software adapter via --enable-unsafe-webgpu (no hardware GPU detected)" };
    })(),
    gpu: "software",
  };
}
