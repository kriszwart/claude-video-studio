import { describe, expect, it } from "vitest";
import type { ProjectDocument } from "@vs/domain";
import { DEFAULT_BRAND, getBuiltinTemplate, instantiateTemplate } from "@vs/templates";
import { projectFlow } from "../../components/editor/flow";
import type { ExportDTO, JobDTO } from "../../components/editor/types";

let n = 0;
const newId = (p: string) => `${p}${++n}`;
const base = (): ProjectDocument => {
  const doc = instantiateTemplate(getBuiltinTemplate("mascot-story")!, {
    title: "Pip",
    brand: DEFAULT_BRAND,
    inputs: { characterName: "Pip", species: "robot", color: "#22c55e", theme: "From garage to galaxy", eras: ["The garage", "The city", "The moon"], transformation: "Pip becomes a star pilot", finale: "Build yours" } as never,
    newId,
    durationSec: 35,
  });
  doc.scenes[0]!.script.narration = "Pip started in a garage.";
  doc.scenes[1]!.script.narration = "Then the city.";
  return doc;
};
const REV = "rev_1";
const job = (type: string, status: string, revisionId: string | null = REV): JobDTO => ({ id: `job_${++n}`, type, status, stage: "working", progress: null, attempts: 1, maxAttempts: 1, revisionId, error: null, result: null, createdAt: "", startedAt: null, finishedAt: null });
const render = (kind: "preview" | "final", revisionId = REV) => ({ id: `exp_${++n}`, kind, revisionId }) as ExportDTO;
const voiceAll = (doc: ProjectDocument) => {
  for (const s of doc.scenes) if (s.script.narration.trim()) doc.audio.push({ id: newId("trk"), kind: "voiceover", assetId: newId("ast"), anchor: { type: "scene", sceneId: s.id, offsetFrames: 0 }, sourceInSec: 0, sourceOutSec: null, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0, duck: { enabled: false, amountDb: -12 } } as never);
  return doc;
};
const flow = (doc: ProjectDocument, jobs: JobDTO[] = [], exports: ExportDTO[] = [], blocking: string[] = []) => projectFlow({ doc, jobs, exports, revisionId: REV, blocking });
const states = (f: ReturnType<typeof flow>) => Object.fromEntries(f.steps.map((s) => [s.id, s.state]));

describe("guided project flow", () => {
  it("starts at the script while it waits for approval, and the rest waits", () => {
    const doc = base();
    doc.script = { status: "draft", style: "documentary", beats: [] } as never;
    const f = flow(doc);
    expect(f.next?.id).toBe("script");
    expect(f.next?.actionLabel).toBe("Review the script");
    expect(states(f)).toMatchObject({ script: "next", storyboard: "todo", draft: "todo", export: "todo" });
  });

  it("shows work in progress without blocking the steps after it", () => {
    const doc = base();
    const f = flow(doc, [job("plan", "running")]);
    expect(f.next?.id).toBe("storyboard");
    expect(f.next?.state).toBe("working");
  });

  it("sends a pending shot plan to its review screen", () => {
    const doc = base();
    doc.review = { status: "pending", next: {} };
    expect(flow(doc).next?.action).toEqual({ kind: "review" });
  });

  it("asks for the voiceover when narrated scenes have none, then moves on", () => {
    const doc = base();
    expect(doc.scenes.some((s) => s.script.narration.trim())).toBe(true);
    expect(flow(doc).next?.id).toBe("voice");
    const f = flow(voiceAll(doc));
    expect(states(f).voice).toBe("done");
    expect(f.next).toMatchObject({ id: "draft", action: { kind: "render" } });
  });

  it("puts keyframes and the animatic before paid video generation", () => {
    const doc = voiceAll(base());
    const s = doc.scenes[0]!;
    s.shot = { kind: "video", prompt: "a robot in a garage", continuity: "", characterIds: [], referenceAssetIds: [], source: "generate", status: "pending", candidates: [], autoAccepted: false, variant: 1 };
    expect(flow(doc).next).toMatchObject({ id: "shots", actionLabel: "Go to keyframes" });
    s.shot.keyframeAssetId = "ast_kf";
    doc.animatic = { status: "pending" };
    expect(flow(doc).next?.actionLabel).toBe("Go to the animatic");
    doc.animatic = { status: "approved" };
    expect(flow(doc).next?.actionLabel).toBe("Go to shots");
    s.shot.acceptedAssetId = "ast_v";
    expect(flow(doc).next?.id).toBe("draft");
  });

  it("names the timeline problem instead of offering a render that would fail", () => {
    const f = flow(voiceAll(base()), [], [], ["Scene 2 has no media"]);
    expect(f.next).toMatchObject({ id: "draft", hint: "Fix first: Scene 2 has no media" });
  });

  it("offers Claude's review as optional with a skip to export, and finishes on a final export", () => {
    const doc = voiceAll(base());
    const drafted = flow(doc, [], [render("preview")]);
    expect(drafted.next).toMatchObject({ id: "review", optional: true });
    expect(drafted.skipTo?.id).toBe("export");
    const reviewed = flow(doc, [job("critique", "succeeded")], [render("preview")]);
    expect(reviewed.next?.id).toBe("export");
    expect(flow(doc, [job("critique", "succeeded")], [render("final")]).next).toBeNull();
  });

  it("treats a render of an older version as not drafted", () => {
    const f = flow(voiceAll(base()), [job("critique", "succeeded", "rev_0")], [render("final", "rev_0")]);
    expect(f.next?.id).toBe("draft");
    expect(states(f)).toMatchObject({ review: "todo", export: "todo" });
  });

  it("points back at a used take Claude says doesn't match, until the owner keeps it", () => {
    const doc = voiceAll(base());
    const s = doc.scenes[0]!;
    const review = { paletteSimilarity: 0.9, flagged: false, method: "colour", decision: "pending" as const, claude: { verdict: "mismatch" as const, summary: "Logo garbled.", checks: [], frames: 1, model: null, checkedAt: "" } };
    s.shot = { kind: "image", prompt: "bottle", continuity: "", characterIds: [], referenceAssetIds: ["ast_ref"], source: "generate", status: "accepted", candidates: [{ assetId: "ast_t", provider: "openrouter", createdAt: "", review }], acceptedAssetId: "ast_t", autoAccepted: true, variant: 1 };
    expect(flow(doc).next).toMatchObject({ id: "shots", hint: expect.stringContaining("scene 1 doesn't match your product") });
    review.decision = "approved" as never;
    expect(flow(doc).next?.id).toBe("draft");
  });
});
