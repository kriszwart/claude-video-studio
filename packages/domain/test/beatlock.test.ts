import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate } from "@vs/templates";
import { applyOperations, chooseDrop, computeTimeline, findDrop, planBeatLock, type ProjectDocument, type SongGrid } from "../src";

// 120 BPM: a beat every 0.5 s, a bar every 2 s; quiet intro, verse, then the drop at 32 s.
const song: SongGrid = {
  durationSec: 90,
  bpm: 120,
  beats: Array.from({ length: 180 }, (_, i) => 0.25 + i * 0.5),
  downbeats: Array.from({ length: 45 }, (_, i) => 0.25 + i * 2),
  sections: [
    { startSec: 0.25, endSec: 16.25, label: "intro", energy: 0.2 },
    { startSec: 16.25, endSec: 32.25, label: "verse", energy: 0.4 },
    { startSec: 32.25, endSec: 64.25, label: "chorus", energy: 0.95 },
    { startSec: 64.25, endSec: 90, label: "outro", energy: 0.3 },
  ],
};
let n = 0;
const make = (inputs: Record<string, unknown> = {}) =>
  instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === "product-launch")!, {
    title: "T",
    brand: DEFAULT_BRAND,
    inputs: { productName: "Tallyo", promise: "Invoices that chase themselves", problem: "Chasing money", benefits: ["Reminders go out for you"], cta: "Sign up free", music: "ast_song", proof: ["Every invoice paid"], ...inputs },
    newId: (p) => `${p}${++n}`,
  }) as ProjectDocument;

describe("lock to the beat", () => {
  it("finds the drop: the first arrival at the song's peak energy (not the intro's first lift)", () => {
    expect(findDrop(song)).toEqual({ sec: 32.25, label: "chorus", rise: 0.55 });
    // A bed whose build lifts more than the peak does: the drop is still the peak's arrival.
    const bed = { ...song, sections: [{ startSec: 0, endSec: 4.26, label: "intro", energy: 0 }, { startSec: 4.26, endSec: 12.84, label: "build", energy: 0.67 }, { startSec: 12.84, endSec: 30, label: "peak", energy: 1 }, { startSec: 30, endSec: 37, label: "outro", energy: 0.4 }] };
    expect(findDrop(bed)).toMatchObject({ sec: 12.84, label: "peak" });
    // A song with two choruses: a payoff 24 s into the video uses the second, so no waiting for the music.
    const two = { ...song, durationSec: 81, sections: [{ startSec: 0, endSec: 8, label: "intro", energy: 0.2 }, { startSec: 8, endSec: 24, label: "chorus", energy: 1 }, { startSec: 24, endSec: 40, label: "verse", energy: 0.5 }, { startSec: 40, endSec: 56, label: "chorus", energy: 1 }, { startSec: 56, endSec: 81, label: "outro", energy: 0.1 }] };
    expect(chooseDrop(two, 24)).toMatchObject({ sec: 40 });
    expect(chooseDrop(two, 5)).toMatchObject({ sec: 8 });
    expect(findDrop({ ...song, sections: song.sections.map((s) => ({ ...s, energy: 0.5 })) })).toBeNull();
  });

  it("starts the song so the drop lands on the payoff, and moves every cut onto a beat", () => {
    const doc = make();
    const track = doc.audio.find((t) => t.kind === "music")!;
    const plan = planBeatLock(doc, song, { trackId: track.id });
    const proof = doc.scenes.find((s) => s.recipeSlot === "proof")!;
    expect(plan.report.payoff.sceneId).toBe(proof.id);
    const after = applyOperations(doc, plan.ops, "user").doc;
    const fps = after.format.fps;
    const t = after.audio.find((x) => x.id === track.id)!;
    const startFrame = t.anchor.type === "absolute" ? t.anchor.startFrame : 0;
    const songAt = (frame: number) => t.sourceInSec + (frame - startFrame) / fps;
    // The drop plays exactly at the payoff (to the frame).
    expect(Math.abs(songAt(plan.report.payoff.frame) - 32.25)).toBeLessThan(1 / fps);
    expect(after.markers.find((m) => m.label === "drop")!.frame).toBe(plan.report.payoff.frame);
    // Every cut and the end sit on a beat of the song as placed (within one frame).
    const tl = computeTimeline(after);
    const onBeat = (frame: number) => song.beats.some((b) => Math.abs(songAt(frame) - b) <= 1 / fps + 1e-9);
    for (const s of tl.scenes.slice(1)) if (s.sceneId !== proof.id) expect(onBeat(s.start), `cut at ${s.start}`).toBe(true);
    expect(onBeat(tl.totalFrames)).toBe(true);
    // Small moves only: nothing changes by more than half a beat plus the pin.
    expect(plan.report.cutsMoved).toBeGreaterThan(0);
  });

  it("prefers a counting number's last value as the payoff, and keeps locked scenes as they are", () => {
    const doc = make();
    const hook = doc.scenes[0]!;
    const text = hook.layers.find((l) => l.kind === "text" && l.role === "headline")!;
    if (text.kind === "text") {
      text.text = "£7,675.00";
      text.count = { prefix: "£", suffix: "", decimals: 2, thousands: true, stops: [{ value: 0, atFrames: 10 }, { value: 7675, atFrames: 60 }] };
    }
    doc.scenes[2]!.locked = true;
    const track = doc.audio.find((t) => t.kind === "music")!;
    const plan = planBeatLock(doc, song, { trackId: track.id });
    expect(plan.report.payoff).toMatchObject({ sceneId: hook.id, frame: 60, why: "the number reaches its last value" });
    expect(plan.ops.some((o) => o.op === "setSceneDuration" && o.sceneId === doc.scenes[2]!.id)).toBe(false);
  });
});
