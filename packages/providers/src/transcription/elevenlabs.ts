import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { groupWords, type TranscriptionProvider, type TranscriptionResult } from "./types";

/**
 * ElevenLabs Scribe speech-to-text (POST /v1/speech-to-text, multipart). Request and
 * response field names follow the official @elevenlabs/elevenlabs-js 2.70.0 type
 * definitions (model_id, file, timestamps_granularity, diarize, tag_audio_events;
 * words[].text/start/end/type/speaker_id). Status: implemented, NOT live-verified here
 * (no key; api.elevenlabs.io is unreachable from this environment).
 */
export class ElevenLabsStt implements TranscriptionProvider {
  id = "elevenlabs-stt";
  kind = "hosted" as const;
  constructor(private apiKey: string, private model = process.env.ELEVENLABS_STT_MODEL ?? "scribe_v2") {}
  async transcribe(file: string, opts: { language?: string; signal?: AbortSignal } = {}): Promise<TranscriptionResult> {
    const form = new FormData();
    form.set("model_id", this.model);
    form.set("timestamps_granularity", "word");
    form.set("diarize", "true");
    form.set("tag_audio_events", "true");
    if (opts.language) form.set("language_code", opts.language);
    form.set("file", new Blob([await readFile(file)]), basename(file));
    const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": this.apiKey }, body: form, signal: opts.signal });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 200);
      const e = new Error(`ElevenLabs speech-to-text failed (${r.status}): ${body}`) as Error & { status?: number };
      e.status = r.status;
      throw e;
    }
    const j = (await r.json()) as { language_code?: string; words?: { text: string; start?: number; end?: number; type: string; speaker_id?: string }[] };
    // Only spoken words become transcript text; audio events (laughter, applause) are kept out of captions.
    const words = (j.words ?? []).filter((w) => w.type === "word" && w.start !== undefined && w.end !== undefined).map((w) => ({ text: w.text.trim(), startSec: w.start!, endSec: w.end!, speaker: w.speaker_id }));
    return { provider: this.id, language: j.language_code ?? null, granularity: "word", segments: groupWords(words) };
  }
}
