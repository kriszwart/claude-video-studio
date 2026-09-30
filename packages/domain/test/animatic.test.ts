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
