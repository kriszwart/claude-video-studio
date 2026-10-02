import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate } from "@vs/templates";
import { buildCriticPrompt, imageBlocks, runCritic, validateCritique, type ClaudeBackend, type CriticContext, type CriticOutput } from "../src";

const template = BUILTIN_TEMPLATES.find((t) => t.id === "motion-reel")!;
let n = 0;
const doc = instantiateTemplate(template, { title: "Focus", brand: { ...DEFAULT_BRAND, name: "Tidewave" }, inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave" }, newId: (p) => `${p}${++n}` });
const frames = doc.scenes.map((_, i) => ({ n: i + 1, sceneIndex: i, timeSec: i * 3 + 1, kind: "hero" as const, data: "AAAA", mediaType: "image/jpeg" as const }));
const ctx: CriticContext = { doc, templateName: template.name, frames, measured: [{ code: "text_overflow", severity: "creative", message: "Overflow", repairable: true }], voiceoverSec: {} };
const good = (over: Partial<CriticOutput> = {}): CriticOutput => ({
  summary: "s",
  scores: { story: 3, visuals: 4, readability: 2, pacing: 3 },
  strengths: ["x"],
  stillChange: [{ scene: 1, text: "Hold the hook a beat longer.", check: false }, { scene: 0, text: "Listen for the music under the voice.", check: true }],
  findings: [
    { scene: 1, frame: 1, category: "readability", severity: "nit", observation: "o", suggestion: "s", request: "" },
    { scene: 2, frame: 2, category: "pacing", severity: "fix", observation: "o", suggestion: "s", request: "Hold longer." },
  ],
  ...over,
});

describe("critic", () => {
  it("validates scores, scene/frame references and locked scenes", () => {
    expect(validateCritique(good(), ctx)).toEqual([]);
    expect(validateCritique(good({ scores: { story: 6, visuals: 4, readability: 2, pacing: 3 } }), ctx).join()).toMatch(/scores.story/);
    const wrongFrame = good({ findings: [{ ...good().findings[0]!, scene: 1, frame: 2 }] });
    expect(validateCritique(wrongFrame, ctx).join()).toMatch(/image 2 shows scene 2, not scene 1/);
    const lockedDoc = { ...doc, scenes: doc.scenes.map((s, i) => (i === 1 ? { ...s, locked: true } : s)) };
    expect(validateCritique(good(), { ...ctx, doc: lockedDoc }).join()).toMatch(/scene 2 is locked/);
  });

  it("sends labelled images with the first message and sorts findings by severity", async () => {
    const calls: Parameters<ClaudeBackend["structured"]>[0][] = [];
    const backend: ClaudeBackend = {
      kind: "subscription",
      structured: async (call) => {
        calls.push(call);
        const json = good();
        return { json, text: JSON.stringify(json), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, model: "m", runtime: "subscription" } };
      },
    };
    const run = await runCritic(backend, ctx);
    expect(calls[0]!.images).toHaveLength(frames.length);
    expect(calls[0]!.images![0]!.label).toBe("Image 1 — scene 1 at 1.00s (hero)");
    expect(run.output.findings.map((f) => f.severity)).toEqual(["fix", "nit"]);
    expect(buildCriticPrompt(ctx)).toContain('"code":"text_overflow"');
  });

  it("builds label + base64 image content blocks in order", () => {
    expect(imageBlocks([{ label: "Image 1", mediaType: "image/jpeg", data: "QUJD" }])).toEqual([
      { type: "text", text: "Image 1" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
    ]);
  });

  it("requires a readability finding for each measured contrast problem and lists it in the prompt", () => {
    const withContrast: CriticContext = { ...ctx, contrast: [{ scene: 2, frame: 2, layerId: "lay", text: "Plan less", ratio: 1.7, textColor: "#2b2d6b", background: "#524ae3", halo: false }] };
    expect(buildCriticPrompt(withContrast)).toContain('"ratio":1.7');
    expect(buildCriticPrompt(withContrast)).toMatch(/"visuals":\[/);
    expect(validateCritique(good(), withContrast).join()).toMatch(/scene 2 .*1.7:1/);
    const fixed = good({ findings: [...good().findings, { scene: 2, frame: 2, category: "readability", severity: "fix", observation: "1.7:1", suggestion: "White text", request: "Change the text colour to #ffffff." }] });
    expect(validateCritique(fixed, withContrast)).toEqual([]);
  });

  it("keeps 'what I'd still change' short: at most three changes and two things to check, changes first", () => {
    expect(validateCritique(good(), ctx)).toEqual([]);
    const many = good({ stillChange: [1, 2, 3, 4].map((k) => ({ scene: 1, text: `c${k}`, check: false })) });
    expect(validateCritique(many, ctx)).toContain("stillChange: at most three changes.");
    expect(validateCritique(good({ stillChange: [{ scene: 99, text: "x", check: false }] }), ctx)[0]).toMatch(/stillChange\[0\]\.scene/);
  });
});

