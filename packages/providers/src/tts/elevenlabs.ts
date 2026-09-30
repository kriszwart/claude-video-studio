import { writeFile } from "node:fs/promises";
import type { TtsProvider, TtsResult, Voice } from "./types";

/**
 * ElevenLabs text-to-speech over its REST API (GET /v1/voices, POST /v1/text-to-speech/{id}).
 * Status: implemented from the documented API and tested against a local stand-in; NOT
 * live-verified in this environment (no key; api.elevenlabs.io unreachable). Voices come from
 * the account's own catalog. Usage is billed per character by ElevenLabs.
 */
export class ElevenLabsError extends Error {
  constructor(public code: "auth" | "quota" | "rate_limited" | "unknown_voice" | "unreachable" | "server_error", message: string) {
    super(message);
  }
}

/** API base; overridable outside production for the test stand-in only. */
function apiBase(): string {
  const o = process.env.NODE_ENV !== "production" ? process.env.ELEVENLABS_BASE_URL : undefined;
  return (o || "https://api.elevenlabs.io").replace(/\/+$/, "");
}

const voiceCache = new Map<string, { at: number; voices: Voice[] }>();
const VOICE_TTL_MS = 5 * 60_000;

async function classify(r: Response): Promise<ElevenLabsError> {
  const text = (await r.text().catch(() => "")).slice(0, 400);
  let status = "";
  try {
    status = String((JSON.parse(text) as { detail?: { status?: string } }).detail?.status ?? "");
  } catch {
    /* not JSON */
  }
  if (r.status === 401) {
    if (/quota|credits/i.test(status + text)) return new ElevenLabsError("quota", "Your ElevenLabs account has no characters left for this request.");
    return new ElevenLabsError("auth", "ElevenLabs rejected the API key.");
  }
  if (r.status === 404 || /voice_not_found/i.test(status)) return new ElevenLabsError("unknown_voice", "That ElevenLabs voice isn't in your account any more.");
  if (r.status === 429) return new ElevenLabsError("rate_limited", "ElevenLabs is rate-limiting requests right now.");
  if (/quota_exceeded/i.test(status)) return new ElevenLabsError("quota", "Your ElevenLabs account has no characters left for this request.");
  return new ElevenLabsError("server_error", `ElevenLabs returned ${r.status}.`);
}

export class ElevenLabsTts implements TtsProvider {
  id = "elevenlabs";
  kind = "hosted" as const;
  constructor(
    private apiKey: string,
    private model = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_multilingual_v2",
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async req(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const onAbort = () => ac.abort();
    init.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.fetchImpl(`${apiBase()}${path}`, { ...init, headers: { "xi-api-key": this.apiKey, ...(init.headers ?? {}) }, signal: ac.signal });
    } catch {
      if (init.signal?.aborted) throw new Error("canceled");
      throw new ElevenLabsError("unreachable", "Could not reach ElevenLabs.");
    } finally {
      clearTimeout(t);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** The account's voices (cached for a few minutes per key so opening the Audio tab doesn't re-query). */
  async voices(timeoutMs = 8000): Promise<Voice[]> {
    const cached = voiceCache.get(this.apiKey);
    if (cached && Date.now() - cached.at < VOICE_TTL_MS) return cached.voices;
    const r = await this.req("/v1/voices", {}, timeoutMs);
    if (!r.ok) throw await classify(r);
    const j = (await r.json()) as { voices?: { voice_id: string; name: string; category?: string; labels?: { language?: string; accent?: string } }[] };
    const voices = (j.voices ?? [])
      .filter((v) => v.voice_id && /^[A-Za-z0-9]{1,64}$/.test(v.voice_id))
      .map((v) => ({ id: `elevenlabs:${v.voice_id}`, label: `${v.name}${v.category === "cloned" ? " (your clone)" : ""} — ElevenLabs`, language: v.labels?.language ?? v.labels?.accent ?? "" }))
      .sort((a, b) => a.label.localeCompare(b.label));
    voiceCache.set(this.apiKey, { at: Date.now(), voices });
    return voices;
  }

  async synthesize(text: string, voiceId: string, out: string, opts: { rate?: number; signal?: AbortSignal } = {}): Promise<TtsResult> {
    const id = voiceId.replace(/^elevenlabs:/, "");
    if (!/^[A-Za-z0-9]{1,64}$/.test(id)) throw new ElevenLabsError("unknown_voice", "Invalid ElevenLabs voice id.");
    const r = await this.req(
      `/v1/text-to-speech/${encodeURIComponent(id)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: this.model, ...(opts.rate ? { voice_settings: { speed: Math.min(1.2, Math.max(0.7, opts.rate)) } } : {}) }),
        signal: opts.signal,
      },
      5 * 60_000,
    );
    if (!r.ok) throw await classify(r);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!(buf.subarray(0, 3).toString("ascii") === "ID3" || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0))) throw new ElevenLabsError("server_error", "ElevenLabs returned something that isn't MP3 audio.");
    const file = out.replace(/\.wav$/, ".mp3");
    await writeFile(file, buf);
    return { file, provider: this.id, voiceId };
  }
}
