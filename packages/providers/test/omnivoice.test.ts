import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeBaseUrl, OmniVoiceTts, parseVoiceList } from "../src";

const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40)]);
function fake(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const h = routes[path];
    return h ? h(init) : new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

describe("OmniVoice adapter (OpenAI-compatible speech API)", () => {
  it("normalises the server address", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:8000/")).toBe("http://127.0.0.1:8000");
    expect(normalizeBaseUrl("http://localhost:8000/v1")).toBe("http://localhost:8000");
    expect(() => normalizeBaseUrl("ftp://x")).toThrow();
  });

  it("parses the voice-list shapes servers return", () => {
    expect(parseVoiceList(["a", "b"]).map((v) => v.name)).toEqual(["a", "b"]);
    expect(parseVoiceList({ voices: [{ id: "x", name: "X voice" }] })).toEqual([{ name: "x", label: "X voice", language: undefined }]);
    expect(parseVoiceList({ data: [{ voice_id: "y" }] })[0]!.name).toBe("y");
    expect(parseVoiceList({ voices: [{ id: "<script>" }] })).toEqual([]);
  });

  it("merges configured and server voices; lists configured voices even if the server is down", async () => {
    const { f } = fake({ "/v1/audio/voices": () => Response.json({ voices: [{ id: "narrator_warm", name: "Warm narrator" }] }) });
    const tts = new OmniVoiceTts({ baseUrl: "http://127.0.0.1:8000", voices: [{ name: "designed", instructions: "calm, low" }] }, undefined, f);
    expect((await tts.voices()).map((v) => v.id)).toEqual(["omnivoice:designed", "omnivoice:narrator_warm"]);
    const down = new OmniVoiceTts({ baseUrl: "http://127.0.0.1:1", voices: [{ name: "designed" }] }, undefined, (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch);
    expect((await down.voices()).map((v) => v.id)).toEqual(["omnivoice:designed"]);
    const none = new OmniVoiceTts({ baseUrl: "http://127.0.0.1:1" }, undefined, (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch);
    await expect(none.voices()).rejects.toMatchObject({ code: "unreachable" });
  });

  it("synthesises with the OpenAI speech contract, sends the design description and key, writes audio", async () => {
    const { f, calls } = fake({ "/v1/audio/speech": () => new Response(wav, { headers: { "content-type": "audio/wav" } }) });
    const tts = new OmniVoiceTts({ baseUrl: "http://127.0.0.1:8000", model: "omnivoice", voices: [{ name: "designed", instructions: "warm, British" }] }, "sk-local", f);
    const out = join(mkdtempSync(join(tmpdir(), "ov-")), "a.wav");
    const r = await tts.synthesize("Hello there", "omnivoice:designed", out, { rate: 1.1 });
    expect(r).toMatchObject({ provider: "omnivoice", voiceId: "omnivoice:designed", file: out });
    expect(readFileSync(out).subarray(0, 4).toString()).toBe("RIFF");
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body).toEqual({ model: "omnivoice", input: "Hello there", voice: "designed", response_format: "wav", speed: 1.1, instructions: "warm, British" });
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-local");
    // The design description is part of the cache key: editing it re-synthesises.
    const edited = new OmniVoiceTts({ baseUrl: "http://127.0.0.1:8000", voices: [{ name: "designed", instructions: "bright" }] });
    expect(edited.cacheSalt("omnivoice:designed")).not.toBe(tts.cacheSalt("omnivoice:designed"));
  });

  it("sends per-line delivery direction after the voice's own instructions", async () => {
    const { f, calls } = fake({ "/v1/audio/speech": () => new Response(wav, { headers: { "content-type": "audio/wav" } }) });
    const tts = new OmniVoiceTts({ baseUrl: "http://127.0.0.1:8000", voices: [{ name: "designed", instructions: "warm, British" }] }, undefined, f);
    const out = join(mkdtempSync(join(tmpdir(), "ov-")), "a.wav");
    await tts.synthesize("Hello", "omnivoice:designed", out, { rate: 0.9, energy: "calm", note: "stress 'focus'" });
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ speed: 0.9, instructions: "warm, British Calm, measured delivery. stress 'focus'" });
  });

  it("maps errors: unknown voice, non-audio response", async () => {
    const t1 = new OmniVoiceTts({ baseUrl: "http://h:1" }, undefined, fake({ "/v1/audio/speech": () => Response.json({ detail: "voice not found" }, { status: 404 }) }).f);
    await expect(t1.synthesize("x", "omnivoice:nope", "/tmp/x.wav")).rejects.toMatchObject({ code: "unknown_voice" });
    const t2 = new OmniVoiceTts({ baseUrl: "http://h:1" }, undefined, fake({ "/v1/audio/speech": () => new Response("<html>") }).f);
    await expect(t2.synthesize("x", "omnivoice:a", "/tmp/x.wav")).rejects.toMatchObject({ code: "bad_response" });
  });
});
