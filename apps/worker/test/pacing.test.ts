import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate } from "@vs/templates";
import { pacingIssues, voiceFacts } from "../src/handlers/pacing";

let n = 0;
const doc = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === "motion-reel")!, { title: "T", brand: DEFAULT_BRAND, inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave" }, newId: (p) => `${p}${++n}` });
const s0 = doc.scenes[0]!;
const sceneSec = s0.durationFrames / doc.format.fps;
const ten = "one two three four five six seven eight nine ten";

describe("voiceover pacing", () => {
  it("measures rate over speech only, and finds lead-in, mid-line pauses and overrun", () => {
    const f = voiceFacts(s0.id, ten, 5, [[0, 1.2], [2.5, 4.2], [4.8, 5]], sceneSec, 0);
    expect(f.leadingSilenceSec).toBe(1.2);
    expect(f.longestPauseSec).toBe(1.7);
    // First word to last word, the mid-line pause included.
    expect(f.speechSec).toBeCloseTo(4.8 - 1.2, 5);
    expect(f.wordsPerSec).toBeCloseTo(10 / 3.6, 1);
    expect(f.overrunSec).toBeCloseTo(4.8 - sceneSec, 2);
  });

  it("flags rushed, dragging, paused, late and overrunning lines, and nothing for a comfortable one", () => {
    const ok = voiceFacts(s0.id, ten, Math.min(4, sceneSec - 0.2), [], sceneSec, 0);
    expect(pacingIssues(doc, [ok])).toEqual([]);
    const codes = (f: ReturnType<typeof voiceFacts>) => pacingIssues(doc, [f]).map((i) => i.code);
    expect(codes(voiceFacts(s0.id, `${ten} ${ten}`, 4, [], sceneSec, 0))).toContain("voiceover_fast");
    expect(codes(voiceFacts(s0.id, ten, 8, [], 9, 0))).toContain("voiceover_slow");
    expect(codes(voiceFacts(s0.id, ten, 4, [[0, 1.1]], sceneSec, 0))).toContain("voiceover_late_start");
    expect(codes(voiceFacts(s0.id, ten, 4, [[1.5, 3.2]], sceneSec, 0))).toContain("voiceover_pause");
    const over = pacingIssues(doc, [voiceFacts(s0.id, ten, sceneSec + 0.8, [], sceneSec, 0)]).find((i) => i.code === "voiceover_overrun")!;
    expect(over.message).toContain(`into “${doc.scenes[1]!.purpose}”`);
    // Trailing silence past the cut is not speech running over.
    expect(codes(voiceFacts(s0.id, ten, sceneSec + 0.8, [[sceneSec - 0.5, sceneSec + 0.8]], sceneSec, 0))).not.toContain("voiceover_overrun");
  });
});
