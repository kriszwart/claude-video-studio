import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate } from "@vs/templates";
import { computeTimeline, planSoundEffects, resolveAnchor, soundEvents, type ProjectDocument, type SoundKit } from "../src";

let n = 0;
const make = () =>
  instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === "product-launch")!, {
    title: "T",
    brand: DEFAULT_BRAND,
    inputs: { productName: "Tidewave", promise: "Plan less", problem: "Too many tabs", benefits: ["Fast", "Calm"], cta: "Try it free" },
    newId: (p) => `${p}${++n}`,
  }) as ProjectDocument;
const kit: SoundKit = { whoosh: { assetId: "a_wh", hitSec: 0.712, durationSec: 1.4 }, pop: { assetId: "a_pop", hitSec: 0.01, durationSec: 0.3 }, chime: { assetId: "a_ch", hitSec: 0.05, durationSec: 4 }, typing: { assetId: "a_ty", hitSec: 0.02, durationSec: 23 } };
let k = 0;
const newId = () => `trk_${++k}`;

describe("sound effects", () => {
  it("finds the moments: transitions, headlines, typed text and the call to action", () => {
    const doc = make();
    const ev = soundEvents(doc, "moderate");
    expect(ev.map((e) => e.role)).toEqual(expect.arrayContaining(["whoosh", "pop", "typing", "chime"]));
    expect(soundEvents(doc, "minimal").every((e) => e.role === "whoosh" || e.role === "chime")).toBe(true);
    doc.profile.avoided = ["whoosh effects"];
    expect(soundEvents(doc, "moderate").some((e) => e.role === "whoosh")).toBe(false);
  });

  it("starts each sound early by its hit, to the millisecond, anchored to the scene it starts in", () => {
    const doc = make();
    const tl = computeTimeline(doc);
    const fps = doc.format.fps;
    const { tracks } = planSoundEffects(doc, kit, { density: "moderate", newId });
    const events = soundEvents(doc, "moderate");
    for (const t of tracks) {
      const e = events.find((x) => x.label === t.sfx!.event)!;
      const hit = Object.values(kit).find((s) => s!.assetId === t.assetId)!.hitSec;
      const lands = resolveAnchor(t.anchor, tl)! / fps - t.sourceInSec + hit;
      expect(Math.abs(lands - e.frame / fps)).toBeLessThan(0.002);
      expect(t.kind).toBe("sfx");
      expect(t.sourceInSec).toBeGreaterThanOrEqual(0);
    }
    const wh = tracks.find((t) => t.sfx!.role === "whoosh")!;
    expect(wh.anchor.type).toBe("scene");
    // The whoosh starts ~0.7 s before its transition, so it sits in the scene before.
    const scene = doc.scenes.findIndex((s) => s.id === (wh.anchor as { sceneId: string }).sceneId);
    const transitionScene = doc.scenes.findIndex((s) => wh.sfx!.event.startsWith(`Scene ${doc.scenes.indexOf(s) + 1}:`));
    expect(scene).toBe(transitionScene - 1);
    // Typing lasts as long as the typing; one-shots keep at most a short tail.
    const ty = tracks.find((t) => t.sfx!.role === "typing")!;
    expect(ty.sourceOutSec! - ty.sourceInSec).toBeLessThan(5);
  });

  it("leaves out roles the kit lacks and keeps the more important of two crowded moments", () => {
    const doc = make();
    const { tracks, skipped } = planSoundEffects(doc, { pop: kit.pop }, { density: "moderate", newId });
    expect(new Set(tracks.map((t) => t.sfx!.role))).toEqual(new Set(["pop"]));
    expect(skipped.some((s) => s.role === "chime" && /no sound/.test(s.why))).toBe(true);
    const all = planSoundEffects(doc, kit, { density: "rich", newId }).tracks;
    const times = all.map((t) => resolveAnchor(t.anchor, computeTimeline(doc))! / 30 - t.sourceInSec + Object.values(kit).find((s) => s!.assetId === t.assetId)!.hitSec).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(0.3 - 0.002);
  });
});
