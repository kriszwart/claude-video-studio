import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate } from "@vs/templates";
import { compileComposition, type StagedAsset } from "../src";

function build(aspect: "16:9" | "9:16" | "1:1", overrides: Record<string, unknown> = {}) {
  let n = 0;
  const doc = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === "product-launch")!, {
    title: "T",
    aspect,
    brand: { ...DEFAULT_BRAND, name: "Acme", logoAssetId: "logo" },
    inputs: {
      productName: "Acme <b>Pro</b>",
      promise: "Does \"things\" & more",
      problem: "Hook text",
      benefits: ["One", "Two", "Three"],
      screenshots: ["s1", "s2"],
      logo: "logo",
      cta: "Buy now",
      music: "m",
      ...overrides,
    },
    newId: (p) => `${p}${++n}`,
  });
  const assets = new Map<string, StagedAsset>([
    ["s1", { file: "assets/s1.png", kind: "image", width: 1440, height: 900 }],
    ["s2", { file: "assets/s2.png", kind: "image", width: 1440, height: 900 }],
    ["logo", { file: "assets/logo.png", kind: "image" }],
  ]);
  return { doc, out: compileComposition(doc, { scale: 1, assets, fonts: [{ family: "Space Grotesk", weight: 700, file: "fonts/sg.woff2" }, { family: "Inter", weight: 400, file: "fonts/i.woff2" }], gsapFile: "vendor/gsap.min.js", audioMix: { file: "audio/mix.wav" } }) };
}

describe("compileComposition", () => {
  it("emits well-formed inline styles with real font families and alignment", () => {
    const { out } = build("16:9");
    const { document } = parseHTML(out.html);
    const fits = [...document.querySelectorAll(".fit")];
    expect(fits.length).toBeGreaterThan(5);
    for (const el of fits) {
      const style = el.getAttribute("style")!;
      expect(style).toMatch(/font-family:'(Space Grotesk|Inter)',sans-serif;/);
      expect(style).toMatch(/font-weight:\d{3};/);
      expect(style).toMatch(/text-align:(left|center|right);/);
    }
  });

  it("escapes user text and never emits it as markup", () => {
    const { out } = build("16:9");
    expect(out.html).not.toContain("<b>Pro</b>");
    expect(out.html).toContain("&lt;b&gt;Pro&lt;/b&gt;");
    expect(out.html).toContain("&quot;things&quot;");
    expect(out.html).toContain(">&amp;<");
  });

  it("declares root timing and scene clips that add up to the timeline", () => {
    const { out } = build("16:9");
    const { document } = parseHTML(out.html);
    const root = document.querySelector("#root")!;
    expect(root.getAttribute("data-width")).toBe("1920");
    expect(Number(root.getAttribute("data-duration"))).toBeCloseTo(out.durationSec, 3);
    const scenes = [...document.querySelectorAll(".scene")];
    const last = scenes.at(-1)!;
    expect(Number(last.getAttribute("data-start")) + Number(last.getAttribute("data-duration"))).toBeCloseTo(out.durationSec, 2);
    expect(document.querySelector("audio#mix")).toBeTruthy();
    expect(out.html).toContain('window.__timelines["main"] = tl');
  });

  it("reflows slots for portrait instead of cropping", () => {
    const land = build("16:9").out;
    const port = build("9:16").out;
    expect(port.width).toBe(1080);
    expect(port.height).toBe(1920);
    const box = (html: string, cls: string) => {
      const { document } = parseHTML(html);
      const el = document.querySelector(`.scene:nth-of-type(2) ${cls}`) ?? document.querySelectorAll(cls)[1];
      return el!.getAttribute("style")!;
    };
    // The reveal scene's media sits beside the text in landscape and below it in portrait.
    expect(box(land.html, ".media")).not.toBe(box(port.html, ".media"));
  });

  it("omits the proof scene when no proof is supplied, includes it when supplied", () => {
    expect(build("16:9").doc.scenes.map((s) => s.recipeSlot)).toEqual(["hook", "reveal", "benefits", "cta"]);
    const withProof = build("16:9", { proof: ["Cut planning time in half for our team"], proofSource: "Pilot customer" }).doc;
    expect(withProof.scenes.map((s) => s.recipeSlot)).toEqual(["hook", "reveal", "benefits", "proof", "cta"]);
    const q = withProof.scenes[3]!.layers.find((l) => l.kind === "text" && l.role === "quote");
    expect(q && q.kind === "text" && q.approvedFactId).toBeTruthy();
  });

  it("binds benefits to approved facts", () => {
    const { doc } = build("16:9");
    const items = doc.scenes[2]!.layers.filter((l) => l.kind === "text" && l.slot.startsWith("item"));
    expect(items.every((l) => l.kind === "text" && l.approvedFactId)).toBe(true);
    expect(doc.brief.approvedFacts.map((f) => f.text)).toEqual(["One", "Two", "Three"]);
  });
});
