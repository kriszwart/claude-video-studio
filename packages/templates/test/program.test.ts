import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeTimeline, parseSubtitles, programFrames, resolveCaptions, validateTimeline, type TranscriptSegment } from "@vs/domain";
import { buildProgramScenes, DEFAULT_BRAND, getBuiltinTemplate, instantiateTemplate } from "../src";

const segs: TranscriptSegment[] = parseSubtitles(readFileSync(join(import.meta.dirname, "../../../fixtures/sample/talking-head-avocado.srt"), "utf8")).map((s, i) => ({ ...s, id: `seg${i + 1}` }));
let n = 0;
const newId = (p: string) => `${p}${++n}`;
const DUR = 38.21;

function make(id: string, aspect?: "9:16") {
  const def = getBuiltinTemplate(id)!;
  const doc = instantiateTemplate(def, { title: "Avocado toast", aspect, brand: DEFAULT_BRAND, inputs: { recording: "srcvid", visuals: ["img1", "img2"] }, newId, sourceDurationSec: DUR });
  return buildProgramScenes(doc, { segments: segs, sourceDurationSec: DUR, newId, bRollAssetIds: ["img1", "img2"], resetBeats: true });
}

describe("talking-head program builder", () => {
  it("instantiates as the untouched source", () => {
    const def = getBuiltinTemplate("talking-head")!;
    const doc = instantiateTemplate(def, { title: "t", brand: DEFAULT_BRAND, inputs: { recording: "srcvid" }, newId, sourceDurationSec: DUR });
    expect(doc.program!.edl).toHaveLength(1);
    expect(computeTimeline(doc).totalFrames).toBe(Math.round(DUR * 30));
  });

  for (const [id, style] of [["whiteboard-explainer", "whiteboard"], ["course-lesson", "course"], ["presenter-intro", "presenter-intro"], ["talking-head", "balanced"]] as const) {
    it(`${id}: sections cover the whole source and keep speech timing`, () => {
      const doc = make(id);
      expect(doc.program!.style).toBe(style);
      expect(doc.scenes.length).toBe(5);
      expect(computeTimeline(doc).totalFrames).toBe(programFrames(doc));
      expect(validateTimeline(doc).filter((i) => i.severity === "error")).toEqual([]);
      const cues = resolveCaptions(doc, computeTimeline(doc));
      expect(cues.length).toBeGreaterThan(9);
      // Uncut: caption timing equals the source timing.
      const toolB = cues.find((c) => c.cue.text.includes("edit the video"))!;
      expect(toolB.start / 30).toBeGreaterThan(15);
    });
  }

  it("whiteboard alternates full-screen drawings with the presenter split and picks illustrations", () => {
    const doc = make("whiteboard-explainer");
    expect(doc.scenes.map((s) => s.layout)).toEqual(["presenter-split", "whiteboard", "presenter-split", "whiteboard", "presenter-split"]);
    const step1 = doc.scenes[1]!.layers.find((l) => l.kind === "graphics")!;
    expect(step1.kind === "graphics" && step1.params.items).toBe("toast");
    const step2 = doc.scenes[2]!.layers.find((l) => l.kind === "graphics")!;
    expect(step2.kind === "graphics" && String(step2.params.items).split("|")).toEqual(["bowl", "avocado", "lemon"]);
  });

  it("course uses a full-screen opening then rounded takeaways", () => {
    const doc = make("course-lesson");
    expect(doc.scenes[0]!.layout).toBe("lesson-intro");
    expect(doc.scenes.slice(1).every((s) => s.layout === "lesson-takeaway")).toBe(true);
    expect(doc.program!.presenterFraming).toBe("rounded-inset");
    const t = doc.scenes[1]!.layers.find((l) => l.kind === "text" && l.role === "headline");
    expect(t && t.kind === "text" && t.text).toBe("Toast two slices of sourdough until golden");
  });

  it("presenter intro inserts supplied visuals on phrase-mapped beats only", () => {
    const doc = make("presenter-intro");
    expect(doc.beats.length).toBe(2);
    expect(doc.beats.every((b) => b.assetId && b.cue.sourceStartSec !== undefined && b.mode === "strict")).toBe(true);
  });

  it("social variant: portrait, short bold captions", () => {
    const def = getBuiltinTemplate("talking-head")!;
    const base = instantiateTemplate(def, { title: "t", aspect: "9:16", brand: DEFAULT_BRAND, inputs: { recording: "srcvid" }, newId, sourceDurationSec: DUR });
    const doc = buildProgramScenes({ ...base, program: { ...base.program!, style: "social" } }, { segments: segs, sourceDurationSec: DUR, newId, bRollAssetIds: ["v1"], resetBeats: true });
    expect(doc.captions.style).toBe("bold");
    expect(doc.captions.cues.every((c) => c.text.length <= 26)).toBe(true);
    expect(doc.beats[0]!.visualAction).toBe("b-roll");
  });
});
