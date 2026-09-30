import { writeFile } from "node:fs/promises";
import { directionInstructions, type SynthesizeOptions, type TtsProvider, type TtsResult, type Voice } from "./types";

/**
 * OmniVoice (k2-fsa/OmniVoice, open-source multilingual TTS with voice cloning/design) served
 * locally by an OpenAI-compatible server such as omnivoice-server or OmniVoice-local:
 *   POST {baseUrl}/v1/audio/speech  {model, input, voice, response_format, speed, instructions}
 *   GET  {baseUrl}/v1/audio/voices  (optional; voice list)
 * It runs on the owner's machine: compute, no provider bill. Status: implemented against the
 * OpenAI speech contract and tested with a local stand-in; not verified against a real server here.
 */
export interface OmniVoiceSettings {
  baseUrl: string;
  model?: string;
  /** Voices the owner set up on the server (cloned from samples, or designed from a description). */
  voices?: { name: string; label?: string; instructions?: string; language?: string }[];
}

export class OmniVoiceError extends Error {
  constructor(public code: "unreachable" | "bad_response" | "unknown_voice" | "server_error", message: string) {
    super(message);
  }
}

/** Voice names/ids: any printable text up to 100 characters (cloned voices can have names like “Kris (warm)”). */
export const VOICE_NAME = /^[^\u0000-\u001f\u007f<>]{1,100}$/u;

/** OmniVoice Studio (the Mac app) serves its OpenAI-compatible API here while it is open. */
export const OMNIVOICE_STUDIO_URL = "http://127.0.0.1:3900/v1";

export function normalizeBaseUrl(u: string): string {
  const url = new URL(u.trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error("The OmniVoice server address must start with http:// or https://");
  return url.toString().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Parse the voice list formats OmniVoice servers return: ["a"], {voices:[...]}, {data:[...]}, items with id/name/voice_id. */
export function parseVoiceList(j: unknown): { name: string; label?: string; language?: string }[] {
  const arr = Array.isArray(j) ? j : Array.isArray((j as { voices?: unknown[] })?.voices) ? (j as { voices: unknown[] }).voices : Array.isArray((j as { data?: unknown[] })?.data) ? (j as { data: unknown[] }).data : [];
  return arr
    .map((v) => {
      if (typeof v === "string") return { name: v };
      const o = v as { id?: string; name?: string; voice_id?: string; voice?: string; label?: string; description?: string; language?: string };
      const name = o.id ?? o.voice_id ?? o.voice ?? o.name;
      return name ? { name: String(name), label: o.label ?? (o.name && o.name !== name ? o.name : undefined), language: o.language } : null;
    })
    .filter((v): v is { name: string; label?: string; language?: string } => !!v && VOICE_NAME.test(v.name));
}

export class OmniVoiceTts implements TtsProvider {
  id = "omnivoice";
  kind = "local" as const;
  private base: string;
  constructor(private settings: OmniVoiceSettings, private apiKey?: string, private fetchImpl: typeof fetch = fetch) {
    this.base = normalizeBaseUrl(settings.baseUrl);
  }

  private headers(extra: Record<string, string> = {}) {
    return { ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}), ...extra };
  }

  private async call(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const onAbort = () => ac.abort();
    init.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.fetchImpl(`${this.base}${path}`, { ...init, signal: ac.signal });
    } catch {
      if (init.signal?.aborted) throw new Error("canceled");
      const app = /:3900$/.test(new URL(this.base).host) ? "Open the OmniVoice Studio app" : "Start your OmniVoice server";
      throw new OmniVoiceError("unreachable", `OmniVoice at ${this.base} is not responding. ${app} on this computer (or fix the address in Settings → OmniVoice).`);
    } finally {
      clearTimeout(t);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Configured voices plus any the server reports. */
  async voices(timeoutMs = 4000): Promise<Voice[]> {
    const out = new Map<string, Voice>();
    for (const v of this.settings.voices ?? []) out.set(v.name, { id: `omnivoice:${v.name}`, label: `${v.label ?? v.name} (OmniVoice)`, language: v.language ?? "" });
    const r = await this.call("/v1/audio/voices", { headers: this.headers() }, timeoutMs).catch((e) => {
      if (out.size) return null;
      throw e;
    });
    if (r?.ok) {
      for (const v of parseVoiceList(await r.json().catch(() => null))) if (!out.has(v.name)) out.set(v.name, { id: `omnivoice:${v.name}`, label: `${v.label ?? v.name} (OmniVoice)`, language: v.language ?? "" });
    }
    return [...out.values()];
  }

  cacheSalt(voiceId: string): string {
    const v = this.settings.voices?.find((x) => x.name === voiceId.replace(/^omnivoice:/, ""));
    return JSON.stringify([this.base, this.settings.model ?? "", v?.instructions ?? ""]);
  }

  async health(): Promise<{ ok: boolean; message: string; voices: number }> {
    try {
      const v = await this.voices();
      return { ok: true, message: `Connected to OmniVoice at ${this.base}; ${v.length} voice(s) available.`, voices: v.length };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e), voices: 0 };
    }
  }

  async synthesize(text: string, voiceId: string, out: string, opts: SynthesizeOptions = {}): Promise<TtsResult> {
    const name = voiceId.replace(/^omnivoice:/, "");
    const configured = this.settings.voices?.find((v) => v.name === name);
    const body = {
      model: this.settings.model || "omnivoice",
      input: text,
      voice: name,
      response_format: "wav",
      ...(opts.rate ? { speed: Math.min(2, Math.max(0.5, opts.rate)) } : {}),
      // The voice's own instructions first, then this line's delivery direction.
      ...(() => {
        const instructions = [configured?.instructions ?? "", directionInstructions(opts)].filter(Boolean).join(" ");
        return instructions ? { instructions } : {};
      })(),
    };
    const r = await this.call("/v1/audio/speech", { method: "POST", headers: this.headers({ "Content-Type": "application/json", Accept: "audio/wav" }), body: JSON.stringify(body), signal: opts.signal }, 10 * 60_000);
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 200);
      if (r.status === 404 || /voice/i.test(detail)) throw new OmniVoiceError("unknown_voice", `OmniVoice doesn't know the voice “${name}” (${r.status}). Check the voices set up on the server.`);
      throw new OmniVoiceError("server_error", `OmniVoice synthesis failed (${r.status})${detail ? `: ${detail}` : ""}.`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const kind = buf.subarray(0, 4).toString("ascii") === "RIFF" ? "wav" : buf.subarray(0, 3).toString("ascii") === "ID3" || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) ? "mp3" : buf.subarray(0, 4).toString("ascii") === "fLaC" ? "flac" : buf.subarray(0, 4).toString("ascii") === "OggS" ? "ogg" : null;
    if (!kind) throw new OmniVoiceError("bad_response", "OmniVoice returned something that isn't audio.");
    const file = out.replace(/\.wav$/, `.${kind}`);
    await writeFile(file, buf);
    return { file, provider: this.id, voiceId };
  }
}
