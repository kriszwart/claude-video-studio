import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate } from "@vs/templates";
import { computeTimeline } from "@vs/domain";
import { buildOtio } from "../src";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("OTIO export", () => {
  let n = 0;
  const base = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === "motion-reel")!, { title: "T", brand: DEFAULT_BRAND, inputs: { hook: "Hi", headline: "Plan less", brandName: "Tidewave" }, newId: (p) => `${p}${++n}` });
  const [s1, s2] = base.scenes;
  const doc = {
    ...base,
    audio: [
      { id: "vo1", kind: "voiceover" as const, assetId: "a1", anchor: { type: "scene" as const, sceneId: s2!.id, offsetFrames: 6 }, sourceInSec: 0, sourceOutSec: null, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0, duck: { enabled: true, amountDb: -12 } },
      // Two music beds that overlap must land on separate lanes.
      { id: "m1", kind: "music" as const, assetId: "m1", anchor: { type: "absolute" as const, startFrame: 0 }, sourceInSec: 2, sourceOutSec: null, gainDb: -8, fadeInFrames: 0, fadeOutFrames: 0, duck: { enabled: true, amountDb: -12 } },
      { id: "m2", kind: "music" as const, assetId: "m2", anchor: { type: "absolute" as const, startFrame: 30 }, sourceInSec: 0, sourceOutSec: null, gainDb: -8, fadeInFrames: 0, fadeOutFrames: 0, duck: { enabled: true, amountDb: -12 } },
    ],
    markers: [{ id: "mk", frame: 45, kind: "section" as const, label: "Chorus", verified: true }],
  };
  const tl = computeTimeline(doc);
  const otio = buildOtio(doc, { program: { path: "media/program.mp4", frames: tl.totalFrames }, assets: { a1: { path: "media/vo.wav", durationSec: 1.5 }, m1: { path: "media/m1.m4a", durationSec: 60 }, m2: { path: "media/m2.m4a", durationSec: 60 } } }, { projectId: "p", revisionId: "r", width: 1920, height: 1080 }) as J;
  const tracks = otio.tracks.children as J[];

  it("cuts the program at scene boundaries with no gaps", () => {
    const v1 = tracks[0]!;
    expect(v1.children.every((c: J) => c.OTIO_SCHEMA === "Clip.2")).toBe(true);
    expect(v1.children.map((c: J) => c.source_range.start_time.value)).toEqual(tl.scenes.map((s) => s.start));
    expect(v1.children.reduce((a: number, c: J) => a + c.source_range.duration.value, 0)).toBe(tl.totalFrames);
    expect(v1.children[0].name).toBe(`1. ${s1!.purpose}`);
  });

  it("places voiceover after a gap at its scene position and splits overlapping music onto lanes", () => {
    const vo = tracks.find((t) => t.name === "Voiceover")!;
    expect(vo.children[0]).toMatchObject({ OTIO_SCHEMA: "Gap.1", source_range: { duration: { value: tl.scenes[1]!.start + 6 } } });
    expect(vo.children[1]).toMatchObject({ OTIO_SCHEMA: "Clip.2", source_range: { duration: { value: 45 } } });
    const music = tracks.filter((t) => t.kind === "Audio" && t.name.startsWith("Music"));
    expect(music.map((t) => t.name)).toEqual(["Music", "Music 2"]);
    expect(music[0]!.children[0].source_range.start_time.value).toBe(60); // 2 s in
    expect(otio.tracks.markers[0]).toMatchObject({ name: "Chorus", color: "RED", marked_range: { start_time: { value: 45 } } });
  });
});
