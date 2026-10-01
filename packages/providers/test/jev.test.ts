import { describe, expect, it } from "vitest";
import { composerQuestions, interpretComposer, JevClient, JevError, type SuggestTemplate } from "../src";

const T: SuggestTemplate[] = [
  { id: "product-launch", name: "Product Launch", description: "Launch a product", supportedAspects: ["16:9", "9:16", "1:1"], duration: { minSec: 15, maxSec: 90, defaultSec: 30 } },
  { id: "vertical-short", name: "Vertical Short", description: "A short vertical video", supportedAspects: ["9:16"], duration: { minSec: 10, maxSec: 60, defaultSec: 20 } },
];
const choice = (choice: string, confidence = 0.8) => ({ type: "choice" as const, choice, probabilities: { [choice]: confidence }, confidence });

describe("Jev composer suggestions", () => {
  it("asks about template, orientation, length, style and voiceover, narrowed to a chosen template", () => {
    expect(Object.keys(composerQuestions(T, null))).toEqual(["template", "aspect", "length", "style", "narrated"]);
    const q = composerQuestions(T, T[1]!);
    expect(q.template).toBeUndefined();
    expect(q.aspect).toBeUndefined(); // only one orientation available
    expect(Object.keys((q.length as { criteria: Record<string, string> }).criteria)).toEqual(["15", "30", "45", "60"]);
  });

  it("keeps only confident, valid answers that fit the template", () => {
    const s = interpretComposer({ template: choice("vertical-short"), aspect: choice("16:9"), length: choice("90"), style: choice("energetic"), narrated: { type: "noul", probability: 0.9 } }, T, null);
    expect(s.templateId?.value).toBe("vertical-short");
    expect(s.aspect).toBeUndefined(); // 16:9 isn't supported by the suggested template
    expect(s.durationSec).toBeUndefined(); // 90 s is longer than it allows
    expect(s.scriptStyle?.value).toBe("energetic");
    expect(s.narration).toEqual({ value: true, confidence: 0.9 });
    const unsure = interpretComposer({ template: choice("product-launch", 0.2), style: choice("made-up"), narrated: { type: "noul", probability: 0.5 } }, T, null);
    expect(unsure).toEqual({});
  });

  it("sends a Bearer key to /v1/systemone and maps errors", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const ok = new JevClient("k-123", { baseUrl: "https://jev.example", model: "jev-latest" }, async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { a: { type: "noul", probability: 0.7 } } }), { status: 200 });
    });
    const r = await ok.decide({ request: "x" }, { a: { type: "noul", instructions: "?" } });
    expect(calls[0]!.url).toBe("https://jev.example/v1/systemone");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer k-123");
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ model: "jev-latest", state: { request: "x" } });
    expect(r.answers.a).toEqual({ type: "noul", probability: 0.7 });
    const bad = new JevClient("k", undefined, async () => new Response("nope", { status: 401 }));
    await expect(bad.decide("x", {})).rejects.toMatchObject({ code: "auth" });
    const slow = new JevClient("k", undefined, (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    await expect(slow.decide("x", {}, { timeoutMs: 50 })).rejects.toBeInstanceOf(JevError);
  });
});
