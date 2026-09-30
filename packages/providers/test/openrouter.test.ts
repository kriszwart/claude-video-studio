import { describe, expect, it } from "vitest";
import { decodeDataUrl, MediaProviderError, OpenRouterImages, openRouterEstimate, OpenRouterSettings } from "../src";

const png = "iVBORw0KGgo=";
function fake(res: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  return { calls, f: async (url: string, init?: RequestInit) => (calls.push({ url, init }), res()) };
}

describe("OpenRouter images", () => {
  it("sends the documented image request and reads images + reported cost", async () => {
    const { f, calls } = fake(() => Response.json({ id: "gen-1", model: "g/img", choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${png}` } }] } }], usage: { cost: 0.039 } }));
    const r = await new OpenRouterImages("k", f, "http://x/api/v1").generate({ model: "g/img", prompt: "A bottle", references: [{ mediaType: "image/jpeg", data: "QUJD" }], aspectRatio: "9:16" });
    expect(calls[0]!.url).toBe("http://x/api/v1/chat/completions");
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body).toMatchObject({ model: "g/img", modalities: ["image", "text"], image_config: { aspect_ratio: "9:16" }, usage: { include: true } });
    expect(body.messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } });
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(r).toMatchObject({ costUsd: 0.039, id: "gen-1", images: [`data:image/png;base64,${png}`] });
    expect(decodeDataUrl(r.images[0]!)).toMatchObject({ mediaType: "image/png" });
  });

  it.each([
    [401, "credentials_invalid", false],
    [402, "provider_failed", false],
    [429, "rate_limited", true],
    [400, "invalid_input", false],
    [503, "provider_unavailable", true],
  ])("maps HTTP %s to %s", async (status, code, retryable) => {
    const { f } = fake(() => Response.json({ error: { message: "x" } }, { status }));
    await expect(new OpenRouterImages("k", f, "http://x").generate({ model: "g/img", prompt: "p", references: [] })).rejects.toMatchObject({ code, retryable });
  });

  it("treats no answer as uncertain (never resent) and a text-only reply as a clear failure", async () => {
    const down = new OpenRouterImages("k", async () => { throw new Error("socket hang up"); }, "http://x");
    await expect(down.generate({ model: "g/img", prompt: "p", references: [] })).rejects.toMatchObject({ code: "network_uncertain", retryable: false });
    const { f } = fake(() => Response.json({ choices: [{ message: { content: "only text" } }] }));
    const e = await new OpenRouterImages("k", f, "http://x").generate({ model: "g/text", prompt: "p", references: [] }).catch((x) => x);
    expect(e).toBeInstanceOf(MediaProviderError);
    expect(e.message).toMatch(/returned no image/);
  });

  it("estimates from the owner's price, or unknown", () => {
    expect(openRouterEstimate(OpenRouterSettings.parse({}))).toMatchObject({ kind: "unknown" });
    expect(openRouterEstimate(OpenRouterSettings.parse({ image: { model: "g/img", priceMicros: 40_000 } }))).toMatchObject({ kind: "known", micros: 40_000 });
    expect(OpenRouterSettings.safeParse({ image: { model: "not a model id" } }).success).toBe(false);
  });
});
