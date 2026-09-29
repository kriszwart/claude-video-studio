import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import type { TtsProvider, TtsResult, Voice } from "./types";

function run(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], signal });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${bin} failed (${c}): ${err.slice(-300)}`))));
  });
}

async function hasBinary(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Local speech synthesis (SVOX Pico, fallback eSpeak NG). Real audio generated on the
 * worker; voices are robotic compared with hosted providers — labelled as such in the UI.
 */
export class LocalTts implements TtsProvider {
  id = "local";
  kind = "local" as const;
  async voices(): Promise<Voice[]> {
    const v: Voice[] = [];
    if (await hasBinary("/usr/bin/pico2wave")) {
      v.push({ id: "pico:en-US", label: "Pico — US English (local)", language: "en-US" }, { id: "pico:en-GB", label: "Pico — UK English (local)", language: "en-GB" });
    }
    if (await hasBinary("/usr/bin/espeak-ng")) {
      v.push({ id: "espeak:en-us", label: "eSpeak NG — US English (local, robotic)", language: "en-US" });
    }
    return v;
  }
  async synthesize(text: string, voiceId: string, out: string, opts: { rate?: number; signal?: AbortSignal } = {}): Promise<TtsResult> {
    const clean = text.replace(/[\u0000-\u001f]/g, " ").slice(0, 2000);
    const [engine, lang] = voiceId.split(":");
    if (engine === "pico") {
      // pico2wave has no rate flag; tempo is adjusted later by the mixer if requested.
      await run("/usr/bin/pico2wave", ["-l", lang ?? "en-US", "-w", out, clean], opts.signal);
    } else if (engine === "espeak") {
      const wpm = Math.round(165 * (opts.rate ?? 1));
      await run("/usr/bin/espeak-ng", ["-v", lang ?? "en-us", "-s", String(wpm), "-w", out, clean], opts.signal);
    } else {
      throw new Error(`Unknown local voice ${voiceId}`);
    }
    return { file: out, provider: this.id, voiceId };
  }
}
