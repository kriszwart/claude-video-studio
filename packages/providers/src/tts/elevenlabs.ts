import { writeFile } from "node:fs/promises";
import type { TtsProvider, TtsResult, Voice } from "./types";

/**
 * ElevenLabs text-to-speech over its REST API. Status: implemented, NOT live-verified in
 * this environment (no key; api.elevenlabs.io unreachable). Voices come from the account's
 * own catalog — a display label alone never implies a voice exists.
 */
export class ElevenLabsTts implements TtsProvider {
  id = "elevenlabs";
  kind = "hosted" as const;
  constructor(private apiKey: string, private model = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_multilingual_v2") {}
  async voices(): Promise<Voice[]> {
    const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": this.apiKey } });
    if (!r.ok) throw new Error(`ElevenLabs voices failed (${r.status})`);
    const j = (await r.json()) as { voices: { voice_id: string; name: string; labels?: { language?: string } }[] };
    return j.voices.map((v) => ({ id: `elevenlabs:${v.voice_id}`, label: `${v.name} (ElevenLabs)`, language: v.labels?.language ?? "" }));
  }
  async synthesize(text: string, voiceId: string, out: string, opts: { rate?: number; signal?: AbortSignal } = {}): Promise<TtsResult> {
    const id = voiceId.replace(/^elevenlabs:/, "");
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: this.model, voice_settings: opts.rate ? { speed: Math.min(1.2, Math.max(0.7, opts.rate)) } : undefined }),
      signal: opts.signal,
    });
    if (!r.ok) throw new Error(`ElevenLabs synthesis failed (${r.status})`);
    const file = out.replace(/\.wav$/, ".mp3");
    await writeFile(file, Buffer.from(await r.arrayBuffer()));
    return { file, provider: this.id, voiceId };
  }
}
