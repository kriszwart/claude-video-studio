import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate } from "@vs/templates";
import { applyOperations, OperationError, referencedAssetIds } from "../src";

describe("animatic gate", () => {
  let n = 0;
  const base = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === "anime-opening")!, { title: "T", brand: DEFAULT_BRAND, inputs: { song: "ast_song00000001", excerptStart: 0, excerptEnd: 30, title: "X", synopsis: "Y", characters: ["A"], direction: "anime" }, newId: (p) => `${p}${++n}`, sourceDurationSec: 60 });
  const shots = base.scenes.filter((s) => s.shot?.kind === "video");

  it("keyframes open the gate; only the owner approves, and only when every video shot has one", () => {
    expect(shots.length).toBeGreaterThan(1);
    let doc = applyOperations(base, [{ op: "setShotKeyframe", sceneId: shots[0]!.id, assetId: "ast_kf000000001" }], "system").doc;
    expect(doc.animatic).toEqual({ status: "pending" });
    expect(referencedAssetIds(doc)).toContain("ast_kf000000001");
    expect(() => applyOperations(doc, [{ op: "setAnimaticStatus", status: "approved" }], "user")).toThrow(/needs a keyframe/);
    doc = applyOperations(doc, shots.slice(1).map((s, i) => ({ op: "setShotKeyframe" as const, sceneId: s.id, assetId: `ast_kf00000000${i + 2}` })), "system").doc;
    expect(() => applyOperations(doc, [{ op: "setAnimaticStatus", status: "approved" }], "assistant")).toThrow(OperationError);
    doc = applyOperations(doc, [{ op: "setAnimaticStatus", status: "approved" }], "user").doc;
    expect(doc.animatic!.status).toBe("approved");
    // A new keyframe changes what was approved.
    doc = applyOperations(doc, [{ op: "setShotKeyframe", sceneId: shots[0]!.id, assetId: "ast_kf00000000x" }], "system").doc;
    expect(doc.animatic!.status).toBe("pending");
  });

  it("can't approve an animatic that doesn't exist", () => {
    expect(() => applyOperations(base, [{ op: "setAnimaticStatus", status: "approved" }], "user")).toThrow(/generate keyframes first/);
  });
});

describe("Claude product check on a take", () => {
  let n = 0;
  const base = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === "anime-opening")!, { title: "T", brand: DEFAULT_BRAND, inputs: { song: "ast_song00000001", excerptStart: 0, excerptEnd: 30, title: "X", synopsis: "Y", characters: ["A"], direction: "anime" }, newId: (p) => `${p}${++n}`, sourceDurationSec: 60 });
  const scene = base.scenes.find((s) => s.shot)!;
  const claude = { verdict: "mismatch" as const, summary: "Logo garbled.", checks: [{ aspect: "logo" as const, result: "wrong" as const, note: "Scrambled." }], frames: 1, model: "m", checkedAt: "2026-10-01T00:00:00Z" };
  const withTake = applyOperations(base, [{ op: "addShotCandidate", sceneId: scene.id, candidate: { assetId: "ast_take0000001", provider: "openrouter", createdAt: "2026-10-01T00:00:00Z", review: { paletteSimilarity: 0.8, flagged: false, method: "colour", decision: "pending" } }, autoAccept: true }], "system").doc;

  it("is recorded by the studio beside the colour measure, never by the owner", () => {
    const doc = applyOperations(withTake, [{ op: "setShotFidelity", sceneId: scene.id, assetId: "ast_take0000001", claude }], "system").doc;
    const review = doc.scenes.find((s) => s.id === scene.id)!.shot!.candidates[0]!.review!;
    expect(review).toMatchObject({ paletteSimilarity: 0.8, flagged: false, decision: "pending", claude: { verdict: "mismatch" } });
    expect(() => applyOperations(withTake, [{ op: "setShotFidelity", sceneId: scene.id, assetId: "ast_take0000001", claude }], "user")).toThrow(OperationError);
    expect(() => applyOperations(withTake, [{ op: "setShotFidelity", sceneId: scene.id, assetId: "ast_other000001", claude }], "system")).toThrow(/not a candidate/);
  });
});
