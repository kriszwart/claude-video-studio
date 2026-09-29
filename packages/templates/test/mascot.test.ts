import { describe, expect, it } from "vitest";
import { applyOperations, computeTimeline } from "@vs/domain";
import { DEFAULT_BRAND, getBuiltinTemplate, instantiateTemplate } from "../src";

let n = 0;
const newId = (p: string) => `${p}${++n}`;
const make = (inputs: Record<string, unknown> = {}) =>
  instantiateTemplate(getBuiltinTemplate("mascot-story")!, {
    title: "Pip",
    brand: DEFAULT_BRAND,
    inputs: { characterName: "Pip", species: "robot", color: "#22c55e", theme: "From garage to galaxy", eras: ["The garage", "The city", "The moon"], transformation: "Pip becomes a star pilot", finale: "Build yours", ...inputs } as never,
    newId,
    durationSec: 35,
  });

describe("T2 mascot story", () => {
  it("carries one persistent character reference into every scene and escalates the eras", () => {
    const doc = make();
    expect(doc.characters).toHaveLength(1);
    const ch = doc.characters[0]!;
    expect(ch).toMatchObject({ name: "Pip", mode: "vector", species: "robot", locked: true });
    expect(ch.palette.body).toBe("#22c55e");
    const withChar = doc.scenes.filter((s) => s.layers.some((l) => l.kind === "character" && l.characterId === ch.id));
    expect(withChar.length).toBe(doc.scenes.length - 1); // all but the logo finale
    const eras = doc.scenes.filter((s) => s.recipeSlot === "era");
    expect(eras.map((s) => s.purpose)).toEqual(["Era 1: The garage", "Era 2: The city", "Era 3: The moon"]);
    const accessories = eras.map((s) => (s.layers.find((l) => l.kind === "character") as { accessory: string }).accessory);
    expect(new Set(accessories).size).toBe(3);
    expect(eras[2]!.motionIntensity).toBeGreaterThan(eras[0]!.motionIntensity);
    expect(computeTimeline(doc).totalFrames).toBe(35 * 30);
  });

  it("image mode uses the owner's cutout as the reference", () => {
    const doc = make({ characterImage: "ast_cutout" });
    expect(doc.characters[0]).toMatchObject({ mode: "image", referenceAssetIds: ["ast_cutout"] });
  });

  it("variation changes setting/pose but never the character; locked references are protected", () => {
    const doc = make();
    const era = doc.scenes.find((s) => s.recipeSlot === "era")!;
    const v = applyOperations(doc, [{ op: "varyScene", sceneId: era.id, variant: 42 }], "user").doc;
    const after = v.scenes.find((s) => s.id === era.id)!;
    expect(JSON.stringify(after.background)).not.toBe(JSON.stringify(era.background));
    expect(after.layers.filter((l) => l.kind === "text")).toEqual(era.layers.filter((l) => l.kind === "text"));
    expect(v.characters).toEqual(doc.characters);
    // Deterministic: the same variant gives the same scene.
    expect(applyOperations(doc, [{ op: "varyScene", sceneId: era.id, variant: 42 }], "user").doc.scenes).toEqual(v.scenes);
    // Locked reference: the owner must unlock before changing it; the assistant never can.
    expect(() => applyOperations(doc, [{ op: "updateCharacter", characterId: "char-main", patch: { species: "cat" } }], "user")).toThrow(/locked/);
    expect(() => applyOperations(doc, [{ op: "updateCharacter", characterId: "char-main", patch: { locked: false } }], "assistant")).toThrow(/locked/);
    const unlocked = applyOperations(doc, [{ op: "updateCharacter", characterId: "char-main", patch: { locked: false } }], "user").doc;
    expect(applyOperations(unlocked, [{ op: "updateCharacter", characterId: "char-main", patch: { species: "cat" } }], "user").doc.characters[0]!.species).toBe("cat");
    // Locked scenes can't be varied.
    const lockedScene = applyOperations(doc, [{ op: "setSceneLock", sceneId: era.id, locked: true }], "user").doc;
    expect(() => applyOperations(lockedScene, [{ op: "varyScene", sceneId: era.id, variant: 3 }], "user")).toThrow(/locked/);
  });
});
