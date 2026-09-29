import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  correctedSegments,
  findPhraseOccurrences,
  parseSilenceDetect,
  parseSubtitles,
  programCaptionCues,
  proposeCuts,
  resolveBeats,
  sectionsFromTranscript,
  subtractRanges,
  syncProgramScenes,
  takeaway,
  type ProjectDocument,
  type TranscriptSegment,
} from "../src";

const srt = readFileSync(join(import.meta.dirname, "../../../fixtures/sample/talking-head-avocado.srt"), "utf8");
const segs: TranscriptSegment[] = parseSubtitles(srt).map((s, i) => ({ ...s, id: `seg${i + 1}` }));
// Measured with ffmpeg silencedetect=n=-38dB:d=0.35 on the fixture.
const silences = parseSilenceDetect(
  `silence_start: 0\nsilence_end: 0.579\nsilence_start: 1.839\nsilence_end: 2.840\nsilence_start: 5.654\nsilence_end: 6.546\nsilence_start: 7.603\nsilence_end: 9.806\nsilence_start: 12.994\nsilence_end: 14.179\nsilence_start: 18.279\nsilence_end: 19.026\nsilence_start: 22.289\nsilence_end: 25.084\nsilence_start: 28.955\nsilence_end: 30.133\nsilence_start: 36.839`,
  38.21,
);
let n = 0;
const newId = (p: string) => `${p}${++n}`;

describe("transcript", () => {
  it("parses SRT and VTT", () => {
    expect(segs).toHaveLength(9);
    expect(segs[0]).toMatchObject({ startSec: 0.5, endSec: 2.36, text: "Hi, I'm Sam." });
    const vtt = parseSubtitles("WEBVTT\n\n00:01.000 --> 00:02.500 align:start\n<v Sam>Hello <b>there</b>\n\nNOTE x\n\n1:00:00.000 --> 1:00:01.000\nAlex: Late line");
    expect(vtt).toEqual([
      { startSec: 1, endSec: 2.5, text: "Hello there" },
      { startSec: 3600, endSec: 3601, text: "Late line", speaker: "Alex" },
    ]);
    expect(silences.at(-1)).toEqual({ startSec: 36.839, endSec: 38.21 });
  });

  it("resolves repeated phrases to distinct occurrences", () => {
    const occ = findPhraseOccurrences(segs, "avocado toast");
    expect(occ.map((o) => o.segmentId)).toEqual(["seg2", "seg4"]);
    expect(occ[1]!.occurrence).toBe(2);
    expect(occ[1]!.startSec).toBeGreaterThan(9.7);
    expect(occ[1]!.endSec).toBeLessThanOrEqual(13.55);
    const toolB = findPhraseOccurrences(segs, "tool b.");
    expect(toolB).toHaveLength(1);
    expect(toolB[0]!.startSec).toBeGreaterThan(16);
  });

  it("proposes retake, filler and silence cuts with evidence, keeping speech", () => {
    const cuts = proposeCuts(segs, silences, { durationSec: 38.21, handlesMs: 120, minSilenceSec: 0.5, newId });
    const retake = cuts.find((c) => c.kind === "mistake")!;
    expect(retake.sourceInSec).toBeCloseTo(2.7, 1);
    expect(retake.sourceOutSec).toBeCloseTo(9.604, 2);
    expect(retake.context).toContain("[Today I will show you how to make avocado toast.]");
    // The filler lies inside the retake cut, so it is not proposed twice.
    expect(cuts.filter((c) => c.kind === "filler")).toHaveLength(0);
    const silence = cuts.filter((c) => c.kind === "silence");
    expect(silence.map((c) => Math.round(c.sourceInSec * 10) / 10)).toEqual(expect.arrayContaining([13.1, 22.4]));
    // Every silence cut lies inside measured audio silence (never audible speech), and never
    // inside a transcript segment's interior.
    for (const c of silence) {
      expect(silences.some((x) => c.sourceInSec >= x.startSec && c.sourceOutSec <= x.endSec)).toBe(true);
      for (const s of segs) expect(c.sourceInSec > s.startSec && c.sourceOutSec < s.endSec).toBe(false);
    }
  });

  it("keeps non-speech sound: a transcript gap without audio silence is not cut", () => {
    const cuts = proposeCuts(segs, [], { durationSec: 38.21, handlesMs: 120, minSilenceSec: 0.5, newId });
    expect(cuts.filter((c) => c.kind === "silence")).toHaveLength(0);
  });

  it("flags retakes whose negation differs", () => {
    const s: TranscriptSegment[] = [
      { id: "a", startSec: 0, endSec: 2, text: "You should not use cold butter here." },
      { id: "b", startSec: 2.5, endSec: 4.5, text: "You should use cold butter here, really." },
    ];
    const [c] = proposeCuts(s, [], { durationSec: 5, handlesMs: 100, minSilenceSec: 0.5, newId });
    expect(c!.reason).toMatch(/negation/);
  });

  it("maps beats through cuts (A17) and flags transcript edits", () => {
    const doc = {
      format: { aspect: "16:9", fps: 30, safeArea: "none@1" },
      program: { sourceAssetId: "src", edl: [{ id: "k", sourceAssetId: "src", sourceInSec: 0, sourceOutSec: 38.21, reason: "keep", review: "accepted" }], proposedCuts: [], audioFadeMs: 12, handlesMs: 120, presenterFraming: "full", corrections: {}, cleanupPolicy: { autoAcceptSilence: false, autoAcceptFillers: false }, style: "balanced" },
      beats: [{ id: "b1", cue: { phrase: "avocado toast", occurrence: 2 }, status: "unmapped", durationFrames: 60 }],
    } as unknown as ProjectDocument;
    const before = resolveBeats(doc, segs)[0]!;
    expect(before.status).toBe("mapped");
    // Cut the retake (2.7–9.6 s): occurrence 2 must still land on the kept utterance, 6.9 s earlier.
    doc.program!.edl = subtractRanges(doc.program!.edl, [{ sourceInSec: 2.7, sourceOutSec: 9.604 }]);
    const after = resolveBeats(doc, segs)[0]!;
    expect(after.sourceStartSec).toBeCloseTo(before.sourceStartSec!, 5);
    expect(before.outputFrame! - after.outputFrame!).toBe(Math.round(6.904 * 30));
    // Occurrence 1 was cut: reported, not silently moved.
    doc.beats[0]!.cue.occurrence = 1;
    expect(resolveBeats(doc, segs)[0]!.status).toBe("changed");
    // A correction that removes the phrase is flagged missing.
    doc.beats[0]!.cue.occurrence = 2;
    const fixed = correctedSegments(segs, { seg4: "Today I will show you the best breakfast." });
    expect(resolveBeats(doc, fixed)[0]!.status).toBe("missing");
  });

  it("splits sections at step markers and derives takeaways", () => {
    const secs = sectionsFromTranscript(segs, 38.21);
    expect(secs.map((s) => s.kind)).toEqual(["intro", "step", "step", "step", "outro"]);
    expect(takeaway(secs[1]!.text)).toBe("Toast two slices of sourdough until golden");
    expect(secs[0]!.startSec).toBe(0);
    expect(secs.at(-1)!.endSec).toBe(38.21);
  });

  it("builds source-timed captions that follow the EDL", () => {
    const cues = programCaptionCues(segs, "src", { maxWords: 6, maxChars: 32 });
    expect(cues.every((c) => c.anchor.type === "source" && c.text.length <= 40)).toBe(true);
    expect(cues.map((c) => c.text).join(" ")).toContain("Tool A, and I edit the video in Tool B.");
  });

  it("scene durations follow the kept material", () => {
    const secs = sectionsFromTranscript(segs, 38.21);
    const doc = {
      format: { aspect: "16:9", fps: 30, safeArea: "none@1" },
      program: { sourceAssetId: "src", edl: subtractRanges([{ id: "k", sourceAssetId: "src", sourceInSec: 0, sourceOutSec: 38.21, reason: "keep", review: "accepted" }], [{ sourceInSec: 2.7, sourceOutSec: 9.604 }]), proposedCuts: [] },
      scenes: secs.map((s, i) => ({ id: `s${i}`, sourceRange: { startSec: s.startSec, endSec: s.endSec }, durationFrames: 1, transitionIn: { type: "cut", durationFrames: 0 } })),
    } as unknown as ProjectDocument;
    const synced = syncProgramScenes(doc);
    const total = synced.scenes.reduce((a, s) => a + s.durationFrames, 0);
    expect(total).toBe(Math.round(2.7 * 30) + Math.round((38.21 - 9.604) * 30));
    expect(synced.scenes[0]!.durationFrames).toBeLessThan(Math.round(18.6 * 30) - 200);
  });
});
