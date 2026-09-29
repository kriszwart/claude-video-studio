import { describe, expect, it } from "vitest";
import { applyOperations, computeTimeline } from "@vs/domain";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate } from "@vs/templates";
import { planSchema, planToScenes, toDomainOps, validatePlan, type PlanContext, type PlanOutput } from "../src";

const template = BUILTIN_TEMPLATES.find((t) => t.id === "product-launch")!;
let n = 0;
const newId = (p: string) => `${p}${++n}`;
const doc = instantiateTemplate(template, {
  title: "T",
  brand: DEFAULT_BRAND,
  inputs: { productName: "Tidewave", promise: "Plans your day", problem: "Too many meetings", benefits: ["Saves 5 hours a week", "Protects focus"], screenshots: ["a1"], cta: "Try it" },
  newId,
});
const ctx: PlanContext = {
  template,
  doc,
  assets: [
    { id: "a1", kind: "image", name: "dashboard.png", width: 1440, height: 900 },
    { id: "m1", kind: "audio", name: "track.m4a", durationSec: 30 },
  ],
  targetDurationSec: 30,
  newId,
};
const factId = doc.brief.approvedFacts[0]!.id;

const good: PlanOutput = {
  rationale: "r",
  omitted: [{ recipeSlot: "proof", reason: "No proof supplied" }],
  warnings: [],
  scenes: [
    { recipeSlot: "hook", purpose: "Hook", layout: "kinetic", durationSec: 6, transition: "cut", motionIntensity: 0.7, narration: "", texts: [{ slot: "headline", role: "headline", text: "Too many meetings?", approvedFactId: null }], media: [] },
    { recipeSlot: "reveal", purpose: "Reveal", layout: "hero-split", durationSec: 8, transition: "wipe", motionIntensity: 0.5, narration: "", texts: [{ slot: "headline", role: "headline", text: "Tidewave", approvedFactId: null }], media: [{ slot: "media", assetId: "a1", frame: "laptop" }] },
    { recipeSlot: "benefits", purpose: "Benefits", layout: "benefit-list", durationSec: 10, transition: "fade", motionIntensity: 0.5, narration: "", texts: [{ slot: "item1", role: "body", text: "Saves 5 hours a week", approvedFactId: factId }], media: [] },
    { recipeSlot: "cta", purpose: "CTA", layout: "end-card", durationSec: 6, transition: "zoom", motionIntensity: 0.5, narration: "", texts: [{ slot: "cta", role: "cta", text: "Try it", approvedFactId: null }], media: [] },
  ],
};

describe("planner validation", () => {
  it("accepts a valid plan and converts it into scenes with recipe structure", () => {
    expect(validatePlan(good, ctx)).toEqual([]);
    const scenes = planToScenes(good, ctx);
    expect(scenes).toHaveLength(4);
    expect(scenes[0]!.transitionIn.type).toBe("cut");
    expect(scenes[1]!.layers.find((l) => l.kind === "image")).toMatchObject({ assetId: "a1", frame: "laptop" });
    // Decoration from the recipe is retained.
    expect(scenes[0]!.layers.some((l) => l.kind === "shape")).toBe(true);
    const benefit = scenes[2]!.layers.find((l) => l.kind === "text" && l.slot === "item1");
    expect(benefit && benefit.kind === "text" && benefit.approvedFactId).toBe(factId);
  });

  it("rejects invented figures, paraphrased facts, unknown assets and wrong slots", () => {
    const bad = structuredClone(good);
    bad.scenes[0]!.texts[0]!.text = "Teams waste 12 hours weekly";
    bad.scenes[2]!.texts[0]!.text = "Save hours every week";
    bad.scenes[1]!.media[0]!.assetId = "nope";
    bad.scenes[3]!.texts.push({ slot: "item9", role: "body", text: "x", approvedFactId: null });
    bad.scenes.push({ ...bad.scenes[3]!, media: [{ slot: "media", assetId: "m1", frame: "none" }] });
    const issues = validatePlan(bad, ctx).map((i) => i.message).join("\n");
    expect(issues).toMatch(/figure "12"/);
    expect(issues).toMatch(/verbatim/);
    expect(issues).toMatch(/not in the manifest/);
    expect(issues).toMatch(/not a text slot/);
    expect(issues).toMatch(/audio, not visual/);
  });

  it("produces a structured-output schema without unsupported constraints", () => {
    const s = JSON.stringify(planSchema(template));
    expect(s).not.toMatch(/minimum|maximum|minLength|maxLength/);
    expect(s).toContain('"additionalProperties":false');
  });
});

describe("editor translation", () => {
  const ectx = { doc, request: "", selectedSceneIds: [], assets: ctx.assets, brandKits: [], newId };
  it("turns 'slow down scene three by two seconds' into a scoped duration op", () => {
    const s3 = doc.scenes[2]!;
    const ops = toDomainOps({ explanation: "", clarificationQuestion: null, operations: [{ op: "setSceneDuration", sceneId: s3.id, durationSec: s3.durationFrames / 30 + 2 }] }, ectx);
    const { doc: next, changedSceneIds } = applyOperations(doc, ops, "assistant");
    expect(changedSceneIds).toEqual([s3.id]);
    expect(computeTimeline(next).totalFrames).toBe(computeTimeline(doc).totalFrames + 60);
  });

  it("assistant cannot reword approved claims", () => {
    const s = doc.scenes.find((x) => x.recipeSlot === "benefits")!;
    const l = s.layers.find((x) => x.kind === "text" && x.approvedFactId)!;
    const ops = toDomainOps({ explanation: "", clarificationQuestion: null, operations: [{ op: "updateLayerText", sceneId: s.id, layerId: l.id, text: "Saves 50 hours" }] }, ectx);
    expect(() => applyOperations(doc, ops, "assistant")).toThrow(/approved claim/);
  });

  it("rejects unknown assets and layouts", () => {
    expect(() => toDomainOps({ explanation: "", clarificationQuestion: null, operations: [{ op: "replaceSceneAsset", sceneId: doc.scenes[1]!.id, layerId: "x", assetId: "evil" }] }, ectx)).toThrow(/Unknown asset/);
    expect(() => toDomainOps({ explanation: "", clarificationQuestion: null, operations: [{ op: "setSceneLayout", sceneId: doc.scenes[1]!.id, layout: "<script>" }] }, ectx)).toThrow(/Unknown layout/);
  });
});
