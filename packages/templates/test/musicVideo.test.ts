import { describe, expect, it } from "vitest";
import { applyOperations, computeTimeline, resolveAudio, validateTimeline } from "@vs/domain";
import { buildMusicVideoScenes, DEFAULT_BRAND, excerptSections, getBuiltinTemplate, instantiateTemplate } from "../src";

let n = 0;
const newId = (p: string) => `${p}${++n}`;
const sections = [
  { startSec: 0, endSec: 8, label: "intro", energy: 0 },
  { startSec: 8, endSec: 24, label: "verse", energy: 0.6 },
  { startSec: 24, endSec: 40, label: "chorus", energy: 1 },
  { startSec: 40, endSec: 56, label: "verse", energy: 0.6 },
  { startSec: 56, endSec: 72, label: "chorus", energy: 1 },
  { startSec: 72, endSec: 80, label: "outro", energy: 0.1 },
];

function make(inSec: number, outSec: number, lyrics: string[] = []) {
  const def = getBuiltinTemplate("music-video")!;
  const doc = instantiateTemplate(def, { title: "Song", brand: DEFAULT_BRAND, inputs: { song: "ast_song", excerptStart: inSec, excerptEnd: outSec, songTitle: "Night Drive", artist: "Sample Band" }, newId, sourceDurationSec: 80 });
  return buildMusicVideoScenes(doc, { sections, excerpt: { inSec, outSec }, songTitle: "Night Drive", artist: "Sample Band", motif: "ring", lyrics, newId });
}

describe("T6 music video", () => {
  it("uses exactly the selected excerpt and cuts on section boundaries", () => {
    const doc = make(20, 70, ["Line one", "Line two", "Line three", "Line four"]);
    const tl = computeTimeline(doc);
    expect(tl.totalFrames).toBe(50 * 30);
    const music = resolveAudio(doc, tl, () => 80)[0]!;
    expect(music.track.sourceInSec).toBe(20);
    expect(music.track.sourceOutSec).toBe(70);
    expect(music.durationFrames).toBe(tl.totalFrames);
    // Cuts at 24, 40, 56 s of the song → 4, 20, 36 s of the video.
    expect(tl.scenes.map((s) => s.start / 30)).toEqual([0, 4, 20, 36]);
    expect(doc.musicLock.enabled).toBe(true);
    expect(validateTimeline(doc).filter((i) => i.code.startsWith("music_"))).toEqual([]);
    expect(doc.captions.cues.every((c) => c.timing === "estimated")).toBe(true);
    // Motif grows toward the finale.
    const scale = (i: number) => (doc.scenes[i]!.layers[0] as { box: { w: number } }).box.w;
    expect(scale(3)).toBeGreaterThan(scale(0));
  });

  it("merges slivers at the excerpt edges", () => {
    const s = excerptSections(sections, 23.5, 60);
    expect(s[0]!.startSec).toBe(23.5);
    expect(s.every((x) => x.endSec - x.startSec >= 1.5)).toBe(true);
  });

  it("fits scene cuts to markers, respects locks and never moves the music", () => {
    let doc = make(0, 30);
    // Owner-moved section marker at 10 s; scenes currently cut at 8 and 24.
    doc = applyOperations(doc, [{ op: "setMarkers", markers: [{ id: "m1", frame: 300, kind: "section", label: "", verified: true }, { id: "m2", frame: 720, kind: "section", label: "", verified: true }] }], "user").doc;
    const fitted = applyOperations(doc, [{ op: "fitScenesToMarkers", kinds: ["section"] }], "user").doc;
    expect(computeTimeline(fitted).scenes.map((s) => s.start)).toEqual([0, 300, 720]);
    expect(computeTimeline(fitted).totalFrames).toBe(900);
    const locked = applyOperations(doc, [{ op: "setSceneLock", sceneId: doc.scenes[0]!.id, locked: true }], "user").doc;
    // Nothing else needed moving, so the lock conflict is surfaced instead of silently ignored.
    expect(() => applyOperations(locked, [{ op: "fitScenesToMarkers", kinds: ["section"] }], "user")).toThrow(/is locked/);
  });
});
