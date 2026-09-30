import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, TemplateDefinition } from "@vs/templates";
import { composeInputs, runComposer, validateCompose, type ClaudeBackend, type ComposeContext, type ComposeOutput } from "../src";

const templates = BUILTIN_TEMPLATES.map((t) => TemplateDefinition.parse(t));
const reel = templates.find((t) => t.id === "motion-reel")!;
const ctx = (over: Partial<ComposeContext> = {}): ComposeContext => ({
  prompt: "Teaser for Tidewave: plan less, ship more. Saves 3 hours a week.",
  templates,
  templateId: null,
  settings: { aspect: null, durationSec: null, music: "auto", voice: "auto" },
  assets: [
    { id: "ast_logo", kind: "image", name: "logo.png" },
    { id: "ast_song", kind: "audio", name: "song.m4a", durationSec: 120 },
  ],
  ...over,
});
const good = (over: Partial<ComposeOutput> = {}): ComposeOutput => ({
  templateId: "motion-reel",
  title: "Tidewave teaser",
  aspect: "16:9",
  durationSec: 20,
  narration: false,
  scriptStyle: "professor",
  textInputs: [
    { inputId: "headline", value: "Plan less, ship more", items: [] },
    { inputId: "brandName", value: "Tidewave", items: [] },
    { inputId: "hook", value: "Focus wins", items: [] },
    { inputId: "points", value: "", items: ["Saves 3 hours a week"] },
  ],
  assetInputs: [
    { inputId: "logo", assetIds: ["ast_logo"] },
    { inputId: "music", assetIds: ["ast_song"] },
  ],
  rationale: "Short brand teaser.",
  warnings: [],
  ...over,
});

describe("composer validation", () => {
  it("accepts a grounded proposal and maps it to template inputs", () => {
    expect(validateCompose(good(), ctx())).toEqual([]);
    expect(composeInputs(good(), reel)).toMatchObject({ headline: "Plan less, ship more", points: ["Saves 3 hours a week"], logo: "ast_logo", music: "ast_song", durationSec: 20 });
  });

  it("rejects figures that are not in the request", () => {
    const issues = validateCompose(good({ textInputs: [...good().textInputs.slice(0, 3), { inputId: "points", value: "", items: ["Used by 10,000 teams"] }] }), ctx());
    expect(issues.map((i) => i.message).join()).toMatch(/10,000/);
  });

  it("honours pinned aspect, duration range, music off and the pinned template", () => {
    expect(validateCompose(good(), ctx({ settings: { aspect: "9:16", durationSec: null, music: "auto", voice: "auto" } })).some((i) => i.path === "aspect")).toBe(true);
    expect(validateCompose(good({ durationSec: 400 }), ctx()).some((i) => i.path === "durationSec")).toBe(true);
    expect(validateCompose(good(), ctx({ settings: { aspect: null, durationSec: null, music: "off", voice: "auto" } })).some((i) => /Music is off/.test(i.message))).toBe(true);
    expect(validateCompose(good(), ctx({ templateId: "vertical-short" }))[0]!.path).toBe("templateId");
  });

  it("uses only attachments of a compatible kind and fills required inputs", () => {
    const wrongKind = validateCompose(good({ assetInputs: [{ inputId: "logo", assetIds: ["ast_song"] }] }), ctx());
    expect(wrongKind.some((i) => /needs image/.test(i.message))).toBe(true);
    const invented = validateCompose(good({ assetInputs: [{ inputId: "logo", assetIds: ["ast_nope"] }] }), ctx());
    expect(invented.some((i) => /not an attachment/.test(i.message))).toBe(true);
    const missing = validateCompose(good({ textInputs: good().textInputs.filter((t) => t.inputId !== "hook") }), ctx());
    expect(missing.some((i) => /"hook"/.test(i.message))).toBe(true);
  });

  it("repairs once from validation feedback, then returns", async () => {
    const answers = [good({ aspect: "4:3" as never }), good()];
    const prompts: string[] = [];
    const backend: ClaudeBackend = {
      kind: "subscription",
      structured: async (call) => {
        prompts.push(call.messages.at(-1)!.content);
        const json = answers.shift()!;
        return { json, text: JSON.stringify(json), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, model: "m", runtime: "subscription" } };
      },
    };
    const run = await runComposer(backend, ctx());
    expect(run.attempts).toBe(2);
    expect(prompts[1]).toMatch(/aspect/);
    expect(run.inputs.brandName).toBe("Tidewave");
  });
});
