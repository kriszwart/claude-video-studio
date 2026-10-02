import { describe, expect, it } from "vitest";
import { rankFootage, runFootageQueries, sceneSearchWords, searchLadder, type FootageItem } from "../src";

const scene = (id: string, headline: string, narration = "") => ({ id, purpose: id, headline, narration });

describe("footage queries", () => {
  it("falls back to the scene's own words, without punctuation, when Claude is unavailable", () => {
    expect(sceneSearchWords({ purpose: "Hook", headline: "Soul: sold. Buyer: unexpected.", narration: "" })).toBe("Soul sold Buyer unexpected");
    expect(sceneSearchWords({ purpose: "Hook", headline: "", narration: "I sold my soul to Santa on a cold December night" })).toBe("I sold my soul to Santa");
  });

  it("asks Claude for concrete visual search terms per scene and keeps only scenes it was given", async () => {
    const calls: unknown[] = [];
    const backend = {
      kind: "api" as const,
      structured: async (call: { messages: { content: string }[] }) => {
        calls.push(call);
        return { json: { scenes: [{ sceneId: "s1", query: "christmas lights house night", kind: "video" }, { sceneId: "zzz", query: "x", kind: "video" }] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } as never };
      },
    };
    const r = await runFootageQueries(backend as never, { title: "Selling My Soul to Santa", aspect: "9:16", scenes: [scene("s1", "Soul: sold.")] });
    expect(r.queries).toEqual([{ sceneId: "s1", query: "christmas lights house night", kind: "video" }]);
    expect(String((calls[0] as { messages: { content: string }[] }).messages[0]!.content)).toContain("Soul: sold.");
  });
});

const item = (id: string, over: Partial<FootageItem> = {}): FootageItem => ({
  source: "wikimedia",
  id,
  kind: "video",
  title: id,
  creator: null,
  pageUrl: `https://x/${id}`,
  thumbUrl: `https://x/${id}.jpg`,
  previewUrl: null,
  downloadUrl: null,
  width: 1920,
  height: 1080,
  durationSec: 12,
  license: { status: "attribution", name: "CC BY 4.0", url: null, attributionRequired: true, attribution: "x" },
  ...over,
});

describe("searchLadder", () => {
  it("widens a specific search step by step, without repeats", () => {
    expect(searchLadder({ query: "candles burning dark midnight", broad: "candle flame" })).toEqual(["candles burning dark midnight", "candles burning dark", "candle flame", "candles burning"]);
    // One-word backups match too much that is off topic, so they are skipped.
    expect(searchLadder({ query: "quill signing old parchment", broad: "signing" })).toEqual(["quill signing old parchment", "quill signing old", "quill signing"]);
    expect(searchLadder({ query: "christmas lights" })).toEqual(["christmas lights"]);
  });
});

describe("rankFootage", () => {
  it("drops restricted and unknown licences, prefers the video's orientation and clips long enough for the scene", () => {
    const ranked = rankFootage(
      [
        item("restricted", { license: { status: "restricted", name: "CC BY-NC", url: null, attributionRequired: true, attribution: null } }),
        item("unknown", { license: { status: "unknown", name: "?", url: null, attributionRequired: false, attribution: null } }),
        item("short", { durationSec: 1.5 }),
        item("landscape"),
        item("portrait", { width: 1080, height: 1920 }),
        item("film", { durationSec: 5000 }),
      ],
      { aspect: "9:16", sceneSec: 4 },
    );
    expect(ranked.map((i) => i.id)).toEqual(["portrait", "landscape", "short"]); // the 83-minute film can't be imported
  });
});

describe("footage requests", () => {
  it("identify Fluxtify and retry once after a rate limit, honouring Retry-After", async () => {
    const { getJson, FOOTAGE_USER_AGENT } = await import("../src");
    const seen: string[] = [];
    let n = 0;
    const f = async (_url: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>)["User-Agent"]));
      return ++n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } }) : Response.json({ ok: true });
    };
    expect(await getJson(f, "https://x")).toEqual({ ok: true });
    expect(seen).toEqual([FOOTAGE_USER_AGENT, FOOTAGE_USER_AGENT]);
    expect(FOOTAGE_USER_AGENT).toMatch(/^Fluxtify\/.+fluxtify\.com/);
  });
});
