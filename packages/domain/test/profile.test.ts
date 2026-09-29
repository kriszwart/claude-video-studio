import { describe, expect, it } from "vitest";
import { applyChanges, diffProfiles, profileFromTraits, proposeFromFeedback, traitsFromMeasurements, type ProfileData } from "../src/profile";

const base: ProfileData = { name: "Calm Technical", pacing: "balanced", typeScale: 1, transition: "fade", motionIntensity: 0.6, soundDensity: "moderate", textDensity: "balanced", framing: "full", preferred: [], avoided: [] };

describe("creative profiles", () => {
  it("turns feedback into an explicit proposal and reports what it didn't understand", () => {
    const r = proposeFromFeedback(base, "Use larger text, fewer whooshes and longer explanation shots. Keep split-screen explanations. Make it pop more purple.");
    const by = Object.fromEntries(r.changes.map((c) => [c.field, c]));
    expect(by.typeScale!.to).toBe(1.15);
    expect(by.soundDensity!.to).toBe("minimal");
    expect(by.pacing!.to).toBe("calm");
    expect(by.framing!.to).toBe("split");
    expect(by.avoided!.to).toContain("whoosh effects");
    expect(by.preferred!.to).toEqual(["longer explanation shots", "split-screen explanations"]);
    expect(by.typeScale!.because).toMatch(/larger text/);
    expect(r.unmatched).toEqual(["Make it pop more purple"]);
    const next = applyChanges(base, r.changes);
    expect(diffProfiles(base, next).map((d) => d.field).sort()).toEqual(["avoided", "framing", "pacing", "preferred", "soundDensity", "typeScale"]);
  });

  it("labels measured traits, interpretations and what couldn't be measured", () => {
    const t = traitsFromMeasurements({ kind: "video", durationSec: 24, cuts: [3, 8, 13, 17], fadeCuts: [8, 13, 17], meanMotion: 0.03, hasAudio: true, loudnessLufs: -20, onsetsPerSec: 0.8, silenceRatio: 0.3, tempoBpm: null, frames: [{ timeSec: 1.5, assetId: "ast_a" }] });
    const by = Object.fromEntries(t.map((x) => [x.field, x]));
    expect(by.pacing).toMatchObject({ value: "calm", basis: "measured" });
    expect(by.transition).toMatchObject({ value: "fade", basis: "measured" });
    expect(by.soundDensity).toMatchObject({ value: "minimal", basis: "measured" });
    expect(by.textDensity!.basis).toBe("not measured");
    expect(by.intent!.basis).toBe("interpretation");
    expect(by.pacing!.evidence.map((e) => e.timeSec)).toEqual([3, 8, 13, 17]);
    const p = profileFromTraits("Calm Technical", t);
    expect(p).toMatchObject({ pacing: "calm", transition: "fade", soundDensity: "minimal" });
    // Screenshots only: no motion or sound claims.
    const still = traitsFromMeasurements({ kind: "image", durationSec: null, cuts: [], fadeCuts: [], meanMotion: null, hasAudio: false, loudnessLufs: null, onsetsPerSec: null, silenceRatio: null, tempoBpm: null, frames: [] });
    expect(still.every((x) => x.basis === "not measured")).toBe(true);
  });
});
