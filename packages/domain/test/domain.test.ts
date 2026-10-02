import { describe, expect, it } from "vitest";
import {
  applyOperations,
  computeTimeline,
  decideSpend,
  historyForEdit,
  historyForRedo,
  historyForUndo,
  initialHistory,
  exportSizes,
  Operation,
  OperationError,
  ProjectDocument,
  resolveAudio,
  stableStringify,
  subtractRanges,
  validateTimeline,
  type ProjectDocumentInput,
} from "../src";

function makeDoc(overrides: Partial<ProjectDocumentInput> = {}): ProjectDocument {
  const scene = (id: string, dur: number, transition: "cut" | "fade" = "cut", overlap = 0) => ({
    id,
    purpose: id,
    recipeSlot: id,
    durationFrames: dur,
    layout: "center",
    background: { type: "color" as const, color: "brand.background" },
    transitionIn: { type: transition, durationFrames: overlap },
    layers: [{ id: `${id}-t`, kind: "text" as const, slot: "headline", role: "headline" as const, text: `Text ${id}` }],
  });
  return ProjectDocument.parse({
    schemaVersion: 1,
    title: "Test",
    template: { templateId: "product-launch", version: 1, family: "product-launch" },
    format: { aspect: "16:9", fps: 30 },
    brand: {
      name: "Acme",
      colors: { primary: "#112233", secondary: "#223344", accent: "#ff6600", background: "#000000", surface: "#111111", text: "#ffffff", muted: "#999999" },
      fonts: { heading: { family: "Inter", weight: 700 }, body: { family: "Inter", weight: 400 } },
    },
    profile: {},
    brief: {},
    scenes: [scene("s1", 90), scene("s2", 90, "fade", 15), scene("s3", 120, "fade", 15), scene("s4", 60)],
    ...overrides,
  });
}

describe("timeline", () => {
  it("subtracts transition overlaps from the total", () => {
    const t = computeTimeline(makeDoc());
    expect(t.totalFrames).toBe(90 + 90 + 120 + 60 - 15 - 15);
    expect(t.scenes.map((s) => [s.start, s.end])).toEqual([
      [0, 90],
      [75, 165],
      [150, 270],
      [270, 330],
    ]);
  });

  it("ignores overlap on the first scene and on cuts", () => {
    const doc = makeDoc();
    doc.scenes[0]!.transitionIn = { type: "fade", durationFrames: 10 };
    const t = computeTimeline(doc);
    expect(t.scenes[0]!.start).toBe(0);
    expect(validateTimeline(doc).some((i) => i.code === "first_scene_transition")).toBe(true);
  });

  it("flags transitions longer than a neighbouring scene", () => {
    const doc = makeDoc();
    doc.scenes[1]!.transitionIn = { type: "fade", durationFrames: 95 };
    expect(validateTimeline(doc).find((i) => i.code === "transition_too_long")?.severity).toBe("error");
  });

  it("ripples scene-anchored audio but keeps absolute audio fixed", () => {
    const doc = makeDoc({
      audio: [
        { id: "vo", kind: "voiceover", assetId: "a1", anchor: { type: "scene", sceneId: "s3", offsetFrames: 5 } },
        { id: "m", kind: "music", assetId: "a2", anchor: { type: "absolute", startFrame: 0 } },
      ],
    });
    const before = resolveAudio(doc, computeTimeline(doc), () => 3);
    const { doc: after } = applyOperations(doc, [{ op: "setSceneDuration", sceneId: "s1", durationFrames: 150 }], "user");
    const res = resolveAudio(after, computeTimeline(after), () => 3);
    expect(before.find((r) => r.track.id === "vo")!.startFrame).toBe(155);
    expect(res.find((r) => r.track.id === "vo")!.startFrame).toBe(215);
    expect(res.find((r) => r.track.id === "m")!.startFrame).toBe(0);
    expect(res.find((r) => r.track.id === "m")!.durationFrames).toBe(90); // clamped to 3s of media
  });

  it("estimates narration overflow and prefers measured durations", () => {
    const doc = makeDoc();
    doc.scenes[3]!.script.narration = Array(20).fill("word").join(" "); // ~7.7s in a 2s scene
    expect(validateTimeline(doc).some((i) => i.code === "narration_overflow")).toBe(true);
    doc.audio.push({ id: "vo", kind: "voiceover", assetId: "short", anchor: { type: "scene", sceneId: "s4", offsetFrames: 0 }, sourceInSec: 0, sourceOutSec: null, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0, duck: { enabled: true, amountDb: -12 } });
    expect(validateTimeline(doc, { mediaDurationSec: () => 1.5 }).some((i) => i.code === "narration_overflow")).toBe(false);
  });
});

describe("operations", () => {
  it("revising one scene leaves other scenes' content byte-identical (A02)", () => {
    const doc = makeDoc();
    const { doc: next, changedSceneIds } = applyOperations(
      doc,
      [
        { op: "updateLayerText", sceneId: "s3", layerId: "s3-t", text: "New copy" },
        { op: "setSceneDuration", sceneId: "s3", durationFrames: 180 },
      ],
      "assistant",
    );
    expect(changedSceneIds).toEqual(["s3"]);
    for (const id of ["s1", "s2", "s4"]) {
      expect(stableStringify(next.scenes.find((s) => s.id === id))).toBe(stableStringify(doc.scenes.find((s) => s.id === id)));
    }
    expect(computeTimeline(next).totalFrames).toBe(computeTimeline(doc).totalFrames + 60);
  });

  it("rejects content edits to locked scenes for every actor, but allows ripple", () => {
    const doc = makeDoc();
    doc.scenes[1]!.locked = true;
    for (const actor of ["assistant", "bulk", "user"] as const) {
      expect(() => applyOperations(doc, [{ op: "updateLayerText", sceneId: "s2", layerId: "s2-t", text: "x" }], actor)).toThrow(OperationError);
    }
    const { doc: next } = applyOperations(doc, [{ op: "setSceneDuration", sceneId: "s1", durationFrames: 120 }], "assistant");
    expect(computeTimeline(next).scenes[1]!.start).toBe(105);
    expect(() => applyOperations(doc, [{ op: "setSceneLock", sceneId: "s2", locked: false }], "assistant")).toThrow(/cannot unlock/);
  });

  it("replaceScenes preserves locked scenes exactly", () => {
    const doc = makeDoc();
    doc.scenes[2]!.locked = true;
    const replacement = doc.scenes.map((s) => ({ ...s, layers: s.layers.map((l) => ({ ...l, text: "planner" })) }));
    const { doc: next } = applyOperations(doc, [{ op: "replaceScenes", scenes: replacement as ProjectDocument["scenes"] }], "bulk");
    expect(next.scenes[2]).toEqual(doc.scenes[2]);
    expect((next.scenes[0]!.layers[0] as { text: string }).text).toBe("planner");
  });

  it("protects approved claims from assistant rewrites", () => {
    const doc = makeDoc();
    const layer = doc.scenes[0]!.layers[0]!;
    if (layer.kind === "text") layer.approvedFactId = "f1";
    expect(() => applyOperations(doc, [{ op: "updateLayerText", sceneId: "s1", layerId: "s1-t", text: "Invented claim" }], "assistant")).toThrow(/approved claim/);
    expect(applyOperations(doc, [{ op: "updateLayerText", sceneId: "s1", layerId: "s1-t", text: "Owner edit" }], "user").changedSceneIds).toEqual(["s1"]);
  });

  it("rejects edits that introduce timeline errors", () => {
    const doc = makeDoc();
    expect(() => applyOperations(doc, [{ op: "setSceneDuration", sceneId: "s2", durationFrames: 10 }], "user")).toThrow(/Transition/);
  });

  it("is atomic: a failing op leaves the input untouched", () => {
    const doc = makeDoc();
    const snapshot = stableStringify(doc);
    expect(() =>
      applyOperations(doc, [{ op: "updateLayerText", sceneId: "s1", layerId: "s1-t", text: "ok" }, { op: "deleteScene", sceneId: "missing" }], "user"),
    ).toThrow();
    expect(stableStringify(doc)).toBe(snapshot);
  });

  it("moveScene clears the new first scene's overlap", () => {
    const { doc } = applyOperations(makeDoc(), [{ op: "moveScene", sceneId: "s3", toIndex: 0 }], "user");
    expect(doc.scenes[0]!.id).toBe("s3");
    expect(computeTimeline(doc).scenes[0]!.overlapIn).toBe(0);
  });
});

describe("history", () => {
  it("undo/redo walks logical states without rewriting history", () => {
    let h = initialHistory("r1");
    h = historyForEdit(h, "r2");
    h = historyForEdit(h, "r3");
    const u1 = historyForUndo(h)!;
    expect(u1.target).toBe("r2");
    const u2 = historyForUndo(u1.meta)!;
    expect(u2.target).toBe("r1");
    expect(historyForUndo(u2.meta)).toBeNull();
    const r1 = historyForRedo(u2.meta)!;
    expect(r1.target).toBe("r2");
    const edited = historyForEdit(r1.meta, "r9");
    expect(historyForRedo(edited)).toBeNull();
    expect(historyForUndo(edited)!.target).toBe("r2");
  });
});

describe("source cuts", () => {
  it("splits keep segments around cuts", () => {
    const out = subtractRanges([{ id: "k", sourceInSec: 0, sourceOutSec: 10 }], [{ sourceInSec: 2, sourceOutSec: 3 }, { sourceInSec: 9.5, sourceOutSec: 12 }]);
    expect(out.map((k) => [k.sourceInSec, k.sourceOutSec])).toEqual([
      [0, 2],
      [3, 9.5],
    ]);
  });
});

describe("budget", () => {
  const policy = { currency: "USD" as const, projectCeilingMicros: 1_000_000, operationCeilingMicros: 400_000, unknownPriceRequestsAuthorized: 1 };
  it("blocks work exceeding remaining budget and unknown prices beyond authorisation (A09)", () => {
    expect(decideSpend(policy, { committedMicros: 700_000, unknownPriceRequestsUsed: 0 }, { kind: "known", micros: 350_000, priceTimestamp: "t", basis: "b" })).toMatchObject({ allowed: false, code: "budget_exceeded" });
    expect(decideSpend(policy, { committedMicros: 0, unknownPriceRequestsUsed: 0 }, { kind: "known", micros: 500_000, priceTimestamp: "t", basis: "b" })).toMatchObject({ allowed: false, code: "operation_ceiling" });
    expect(decideSpend(policy, { committedMicros: 0, unknownPriceRequestsUsed: 0 }, { kind: "unknown", reason: "x" })).toMatchObject({ allowed: true });
    expect(decideSpend(policy, { committedMicros: 0, unknownPriceRequestsUsed: 1 }, { kind: "unknown", reason: "x" })).toMatchObject({ allowed: false, code: "unknown_price_unauthorized" });
  });
});

describe("setCaptions", () => {
  it("changes only the settings it names; cues and other settings are kept", () => {
    const cue = { id: "cue1", text: "Hello", anchor: { type: "absolute" as const, startFrame: 0 }, startFrame: 0, endFrame: 30 };
    // Parsed as the operations API parses them, so schema defaults apply as they would there.
    const ops = (raw: unknown[]) => raw.map((o) => Operation.parse(o));
    let doc = applyOperations(makeDoc(), ops([{ op: "setCaptionCues", cues: [cue] }, { op: "setCaptions", captions: { enabled: true, style: "bold", position: "top" } }]), "user").doc;
    expect(doc.captions).toMatchObject({ enabled: true, style: "bold", position: "top" });
    expect(doc.captions.cues).toHaveLength(1);
    doc = applyOperations(doc, ops([{ op: "setCaptions", captions: { enabled: false } }]), "user").doc;
    expect(doc.captions).toMatchObject({ enabled: false, style: "bold", position: "top" });
    expect(doc.captions.cues.map((c) => c.text)).toEqual(["Hello"]);
  });
});

describe("exportSizes", () => {
  it("exports the project's own size by default; extra sizes follow it, without repeats", () => {
    expect(exportSizes("16:9")).toEqual(["16:9"]);
    expect(exportSizes("16:9", ["9:16", "16:9", "1:1", "9:16"])).toEqual(["16:9", "9:16", "1:1"]);
    expect(exportSizes("9:16", ["1:1"])).toEqual(["1:1"]);
    expect(exportSizes("16:9", [])).toEqual(["16:9"]);
  });
});

describe("replaceScenes", () => {
  it("drops narration and captions anchored to scenes that are gone, like deleteScene does", () => {
    const base = makeDoc();
    const [a, b] = base.scenes;
    const vo = (id: string, sceneId: string) => ({ id, kind: "voiceover" as const, assetId: `ast_${id}`, anchor: { type: "scene" as const, sceneId, offsetFrames: 0 } });
    const cue = (id: string, sceneId: string) => ({ id, text: id, anchor: { type: "scene" as const, sceneId, offsetFrames: 0 }, startFrame: 0, endFrame: 10 });
    const music = { id: "mus", kind: "music" as const, assetId: "ast_m", anchor: { type: "scene" as const, sceneId: b!.id, offsetFrames: 0 } };
    let doc = applyOperations(base, [{ op: "addAudioTrack", track: vo("vA", a!.id) }, { op: "addAudioTrack", track: vo("vB", b!.id) }, { op: "addAudioTrack", track: music }, { op: "setCaptionCues", cues: [cue("cA", a!.id), cue("cB", b!.id)] }].map((o) => Operation.parse(o)), "user").doc;
    doc = applyOperations(doc, [Operation.parse({ op: "replaceScenes", scenes: [doc.scenes[0]] })], "user").doc;
    expect(doc.audio.map((t) => t.id)).toEqual(["vA", "mus"]); // music is not narration: it keeps its anchor
    expect(doc.captions.cues.map((c) => c.id)).toEqual(["cA"]);
  });
});
