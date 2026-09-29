import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { groupWords, type TranscriptionProvider, type TranscriptionResult } from "./types";

const exec = promisify(execFile);

/**
 * Local Whisper through whisper.cpp's CLI (`whisper-cli`), configured with
 * WHISPER_CPP_BIN and WHISPER_CPP_MODEL. Word timing comes from `-ml 1` (one token per
 * segment) with `-oj` JSON output — whisper.cpp's word times are token-level estimates
 * from the decoder, so they are reported as "word" only when that mode succeeds.
 * Local runs still use CPU, memory and disk; they are not free. Status: implemented, NOT
 * verified here (model downloads are blocked in this environment).
 */
export class WhisperCppStt implements TranscriptionProvider {
  id = "whisper-cpp";
  kind = "local" as const;
  constructor(private bin = process.env.WHISPER_CPP_BIN ?? "whisper-cli", private model = process.env.WHISPER_CPP_MODEL ?? "") {}
  static available(): boolean {
    return !!process.env.WHISPER_CPP_MODEL && existsSync(process.env.WHISPER_CPP_MODEL) && !!process.env.WHISPER_CPP_BIN && existsSync(process.env.WHISPER_CPP_BIN);
  }
  async transcribe(file: string, opts: { language?: string; signal?: AbortSignal; workDir?: string } = {}): Promise<TranscriptionResult> {
    // whisper.cpp expects 16 kHz mono WAV.
    const dir = opts.workDir ?? "/tmp";
    const wav = join(dir, "whisper-in.wav");
    await exec("ffmpeg", ["-v", "error", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], { signal: opts.signal });
    const base = join(dir, "whisper-out");
    await exec(this.bin, ["-m", this.model, "-f", wav, "-oj", "-of", base, "-ml", "1", "-sow", ...(opts.language ? ["-l", opts.language] : [])], { signal: opts.signal, maxBuffer: 64 * 1024 * 1024 });
    const j = JSON.parse(await readFile(`${base}.json`, "utf8")) as { result?: { language?: string }; transcription: { offsets: { from: number; to: number }; text: string }[] };
    const words = j.transcription.map((t) => ({ text: t.text.trim(), startSec: t.offsets.from / 1000, endSec: t.offsets.to / 1000 })).filter((w) => w.text && !/^\[.*\]$/.test(w.text));
    return { provider: this.id, language: j.result?.language ?? null, granularity: "word", segments: groupWords(words) };
  }
}
