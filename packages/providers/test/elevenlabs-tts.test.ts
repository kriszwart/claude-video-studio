import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ElevenLabsTts, elevenLabsVoiceSettings } from "../src";

const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64)]);
function fake(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { f, calls };
}

describe("ElevenLabs TTS adapter", () => {
  it("lists the account's voices (clones marked), sends the key, caches the list", async () => {
    const { f, calls } = fake(() => Response.json({ voices: [{ voice_id: "abc123", name: "Rachel", category: "premade", labels: { accent: "american" } }, { voice_id: "cl0ne", name: "Kris", category: "cloned" }, { voice_id: "../bad", name: "x" }] }));
    const t = new ElevenLabsTts("key-cache-test", "m", f);
    const v = await t.voices();
    expect(v).toEqual([
      { id: "elevenlabs:cl0ne", label: "Kris (your clone) — ElevenLabs", language: "" },
      { id: "elevenlabs:abc123", label: "Rachel — ElevenLabs", language: "american" },
    ]);
    expect((calls[0]!.init!.headers as Record<string, string>)["xi-api-key"]).toBe("key-cache-test");
    await t.voices();
    expect(calls).toHaveLength(1);
  });

  it("maps delivery direction to voice settings; neutral leaves the voice's own settings", async () => {
    expect(elevenLabsVoiceSettings({})).toBeNull();
    expect(elevenLabsVoiceSettings({ rate: 1, energy: "neutral", note: "stress it" })).toBeNull();
    expect(elevenLabsVoiceSettings({ rate: 0.9, energy: "calm" })).toEqual({ speed: 0.9, stability: 0.75, style: 0 });
    expect(elevenLabsVoiceSettings({ rate: 1.5, energy: "lively" })).toEqual({ speed: 1.2, stability: 0.3, style: 0.45 });
  });

  it("synthesises MP3 with model and speed", async () => {
    const { f, calls } = fake(() => new Response(mp3, { headers: { "content-type": "audio/mpeg" } }));
    const out = join(mkdtempSync(join(tmpdir(), "el-")), "a.wav");
    const r = await new ElevenLabsTts("k", "eleven_multilingual_v2", f).synthesize("Hello", "elevenlabs:abc123", out, { rate: 1.1 });
    expect(r.file).toMatch(/a\.mp3$/);
    expect(readFileSync(r.file).subarray(0, 3).toString()).toBe("ID3");
    expect(calls[0]!.url).toMatch(/\/v1\/text-to-speech\/abc123\?output_format=mp3_44100_128$/);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ text: "Hello", model_id: "eleven_multilingual_v2", voice_settings: { speed: 1.1 } });
  });

  it.each([
    [401, { detail: { status: "invalid_api_key" } }, "auth"],
    [401, { detail: { status: "quota_exceeded" } }, "quota"],
    [429, { detail: { status: "too_many_concurrent_requests" } }, "rate_limited"],
    [404, { detail: { status: "voice_not_found" } }, "unknown_voice"],
    [500, {}, "server_error"],
  ])("maps HTTP %s %j to %s", async (status, body, code) => {
    const { f } = fake(() => Response.json(body, { status }));
    await expect(new ElevenLabsTts("k2", "m", f).synthesize("x", "elevenlabs:abc", "/tmp/x.wav")).rejects.toMatchObject({ code });
  });

  it("rejects malformed voice ids without calling out", async () => {
    const { f, calls } = fake(() => new Response(mp3));
    await expect(new ElevenLabsTts("k", "m", f).synthesize("x", "elevenlabs:../../v1/user", "/tmp/x.wav")).rejects.toMatchObject({ code: "unknown_voice" });
    expect(calls).toHaveLength(0);
  });
});
