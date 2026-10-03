import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate } from "../src";

const make = (id: string, motionIntensity: number, inputs: Record<string, unknown>) => {
  let n = 0;
  return instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === id)!, { title: "T", brand: DEFAULT_BRAND, profile: { motionIntensity }, inputs: inputs as never, newId: (p) => `${p}${++n}` });
};
const launch = { productName: "Acme", promise: "P", problem: "H", benefits: ["One"], screenshots: ["ast_s1", "ast_s2"], cta: "Buy" };
const gfx = (doc: ReturnType<typeof make>) => doc.scenes.flatMap((s) => s.layers.filter((l) => l.kind === "graphics").map((l) => (l.kind === "graphics" ? `${s.recipeSlot}:${l.component}` : "")));

describe("templates scale shader effects with the project's motion setting", () => {
  it("product launch: lively gets shader backgrounds, a lens over the detail and shader transitions", () => {
    const doc = make("product-launch", 0.8, launch);
    expect(gfx(doc)).toEqual(["hook:mesh-gradient", "benefits:glass-lens", "cta:mesh-gradient"]);
    expect(doc.scenes.map((s) => s.transitionIn.type)).toEqual(["cut", "liquid", "fade", "lens", "morph"]);
    // The lens binds the second screenshot; its colours stay brand references until render.
    const lens = doc.scenes.find((s) => s.recipeSlot === "benefits")!.layers.find((l) => l.kind === "graphics")!;
    expect(lens.kind === "graphics" && lens.params.image).toBe("ast_s2");
    const mesh = doc.scenes[0]!.layers.find((l) => l.kind === "graphics")!;
    expect(mesh.kind === "graphics" && String(mesh.params.colors)).toMatch(/^brand\.background,brand\.primary/);
    // The quiet stand-ins are left out (one layer per slot).
    expect(doc.scenes[0]!.layers.some((l) => l.kind === "shape" && l.shape === "blob")).toBe(false);
    expect(doc.scenes.find((s) => s.recipeSlot === "benefits")!.layers.some((l) => l.kind === "image" && l.slot === "media")).toBe(false);
  });

  it("product launch: calm keeps the quiet version (no shader effects, classic transitions)", () => {
    const doc = make("product-launch", 0.3, launch);
    expect(gfx(doc)).toEqual([]);
    expect(doc.scenes.map((s) => s.transitionIn.type)).toEqual(["cut", "wipe", "fade", "zoom", "portal"]);
    expect(doc.scenes.find((s) => s.recipeSlot === "benefits")!.layers.some((l) => l.kind === "image" && l.slot === "media")).toBe(true);
  });

  it("an effect bound to a missing image is left out, not drawn empty", () => {
    const doc = make("product-launch", 0.8, { ...launch, screenshots: ["ast_s1"] });
    expect(gfx(doc)).toEqual(["hook:mesh-gradient", "cta:mesh-gradient"]);
  });

  it("motion reel: lively gets the liquid morph, aurora and all four shader transitions", () => {
    const doc = make("motion-reel", 0.8, { headline: "Plan less", brandName: "Tidewave", hook: "Focus", focal: "Ship it", heroImage: "ast_h1" });
    expect(gfx(doc)).toEqual(["hook:liquid-morph", "kinetic:aurora", "endcard:mesh-gradient"]);
    expect(doc.scenes.map((s) => s.transitionIn.type)).toEqual(["cut", "flythrough", "liquid", "lens", "grain", "morph"]);
    const calm = make("motion-reel", 0.3, { headline: "Plan less", brandName: "Tidewave", hook: "Focus", focal: "Ship it", heroImage: "ast_h1" });
    expect(gfx(calm)).toEqual([]);
    expect(calm.scenes.map((s) => s.transitionIn.type)).toEqual(["cut", "flythrough", "wipe", "zoom", "fade", "zoom"]);
  });
});
