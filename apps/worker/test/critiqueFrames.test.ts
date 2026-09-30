import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate } from "@vs/templates";
import { critiqueFrames } from "../src/handlers/critique";

describe("critique frames", () => {
  it("takes one settled frame per scene, then transitions, within the scene and in time order", () => {
    let n = 0;
    const doc = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === "motion-reel")!, { title: "T", brand: DEFAULT_BRAND, inputs: { hook: "Hi", headline: "Plan less", brandName: "Tidewave" }, newId: (p) => `${p}${++n}` });
    const f = critiqueFrames(doc);
    const heroes = f.filter((x) => x.kind === "hero");
    expect(heroes.map((x) => x.sceneIndex)).toEqual(doc.scenes.map((_, i) => i));
    expect(f.some((x) => x.kind === "transition")).toBe(true);
    expect([...f].sort((a, b) => a.timeSec - b.timeSec)).toEqual(f);
    expect(f.length).toBeLessThanOrEqual(16);
  });
});
