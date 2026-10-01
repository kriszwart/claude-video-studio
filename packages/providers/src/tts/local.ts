import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { TtsProvider, TtsResult, Voice, SynthesizeOptions } from "./types";

function run(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], signal });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${bin} failed (${c}): ${err.slice(-300)}`))));
  });
}

/**
 * Find a TTS binary: an explicit env override, then PATH, then the usual install locations
 * (Linux packages in /usr/bin, Homebrew on Apple Silicon in /opt/homebrew/bin, Intel Macs and
 * source builds in /usr/local/bin).
 */
export async function findBinary(name: "pico2wave" | "espeak-ng"): Promise<string | null> {
  const override = name === "pico2wave" ? process.env.PICO2WAVE_BIN : process.env.ESPEAK_NG_BIN;
  const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
  for (const candidate of override ? [override] : [...new Set(dirs)].map((d) => join(d, name))) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * macOS built-in voices (`say`). Only natural-sounding English voices are offered: any
 * Premium/Enhanced voice the owner has downloaded, then the standard ones below, in this order.
 * Novelty voices (Bells, Zarvox, …) are left out.
 */
const SAY_VOICES = ["Ava", "Zoe", "Allison", "Susan", "Tom", "Evan", "Nathan", "Samantha", "Daniel", "Kate", "Oliver", "Serena", "Karen", "Lee", "Moira", "Fiona", "Tessa", "Rishi", "Veena"];
const SAY_BIN = "/usr/bin/say";

export function parseSayVoices(listing: string): Voice[] {
  const found: { name: string; language: string; rank: number }[] = [];
  for (const line of listing.split("\n")) {
    const m = /^(.+?)\s+(en_[A-Z]{2})\s+#/.exec(line);
    if (!m) continue;
    const name = m[1]!.trim();
    const base = name.replace(/\s*\((Premium|Enhanced)\)$/, "");
    const curated = SAY_VOICES.indexOf(base);
    const quality = /\((Premium|Enhanced)\)$/.test(name);
    if (curated < 0 && !quality) continue;
    found.push({ name, language: m[2]!.replace("_", "-"), rank: (quality ? 0 : 100) + (curated < 0 ? 50 : curated) });
  }
  return found.sort((a, b) => a.rank - b.rank).map((v) => ({ id: `say:${v.name}`, label: `${v.name} — ${v.language} (macOS, local)`, language: v.language }));
}

async function sayVoices(): Promise<Voice[]> {
  if (process.platform !== "darwin") return [];
  try {
    await access(SAY_BIN, constants.X_OK);
  } catch {
    return [];
  }
  return new Promise((resolve) => execFile(SAY_BIN, ["-v", "?"], { timeout: 10_000 }, (err, stdout) => resolve(err ? [] : parseSayVoices(stdout))));
}

/**
 * Local speech synthesis: macOS voices (`say`), SVOX Pico, eSpeak NG. Real audio generated on
 * the worker; Pico and eSpeak are robotic compared with hosted providers — labelled as such.
 */
export class LocalTts implements TtsProvider {
  id = "local";
  kind = "local" as const;
  async voices(): Promise<Voice[]> {
    // macOS voices first: they sound the most natural, and the composer's default is the first local voice.
    const v: Voice[] = await sayVoices();
    if (await findBinary("pico2wave")) {
      v.push({ id: "pico:en-US", label: "Pico — US English (local)", language: "en-US" }, { id: "pico:en-GB", label: "Pico — UK English (local)", language: "en-GB" });
    }
    if (await findBinary("espeak-ng")) {
      v.push({ id: "espeak:en-us", label: "eSpeak NG — US English (local, robotic)", language: "en-US" });
    }
    return v;
  }
  async synthesize(text: string, voiceId: string, out: string, opts: SynthesizeOptions = {}): Promise<TtsResult> {
    const clean = text.replace(/[\u0000-\u001f]/g, " ").slice(0, 2000);
    const [engine, lang] = voiceId.split(":");
    if (engine === "pico") {
      // pico2wave has no rate flag: synthesise, then change tempo without changing pitch.
      const rate = opts.rate ?? 1;
      const raw = rate !== 1 ? out.replace(/\.wav$/, ".raw.wav") : out;
      await run((await findBinary("pico2wave")) ?? "pico2wave", ["-l", lang ?? "en-US", "-w", raw, clean], opts.signal);
      if (raw !== out) {
        await run(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-filter:a", `atempo=${Math.min(2, Math.max(0.5, rate)).toFixed(3)}`, out], opts.signal);
        await rm(raw, { force: true });
      }
    } else if (engine === "say") {
      const name = voiceId.slice(4);
      const wpm = Math.round(175 * (opts.rate ?? 1));
      await run(SAY_BIN, ["-v", name, "-r", String(wpm), "-o", out, "--file-format=WAVE", "--data-format=LEI16@24000", clean], opts.signal);
    } else if (engine === "espeak") {
      const wpm = Math.round(165 * (opts.rate ?? 1));
      await run((await findBinary("espeak-ng")) ?? "espeak-ng", ["-v", lang ?? "en-us", "-s", String(wpm), "-w", out, clean], opts.signal);
    } else {
      throw new Error(`Unknown local voice ${voiceId}`);
    }
    return { file: out, provider: this.id, voiceId };
  }
}
