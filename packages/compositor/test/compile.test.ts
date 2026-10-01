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

describe("character layers", () => {
  it("draws the persistent vector character and animates its pose", async () => {
    const { instantiateTemplate, getBuiltinTemplate, DEFAULT_BRAND } = await import("@vs/templates");
    const { compileComposition } = await import("../src");
    let n = 0;
    const doc = instantiateTemplate(getBuiltinTemplate("mascot-story")!, { title: "Pip", brand: DEFAULT_BRAND, inputs: { characterName: "Pip", species: "cat", theme: "t", eras: ["a", "b"], transformation: "x" }, newId: (p: string) => `${p}${++n}` });
    const out = compileComposition(doc, { scale: 0.5, assets: new Map(), fonts: [], gsapFile: "gsap.min.js" } as never);
    expect((out.html.match(/class="layer character"/g) ?? []).length).toBe(doc.scenes.length - 1);
    expect(out.html).toContain("-arm-r");
    expect(out.html).toMatch(/svgOrigin/);
    expect(out.warnings.filter((w: string) => /character/.test(w))).toEqual([]);
  });
});

describe("A15: hostile project text cannot escape into markup or script", () => {
  it("escapes text, captions, beats, character names and font families", async () => {
    const { instantiateTemplate, getBuiltinTemplate, DEFAULT_BRAND } = await import("@vs/templates");
    let n = 0;
    const evil = `</script><script>window.pwned=1</script><img src=x onerror="pwned">'`;
    const brand = { ...DEFAULT_BRAND, name: evil, fonts: { heading: { family: `Inter</script><script>window.pwned=3</script>`, weight: 700 }, body: { family: `x'; background:url(http://169.254.169.254/)`, weight: 400 } } };
    const doc = instantiateTemplate(getBuiltinTemplate("mascot-story")!, { title: evil, brand, inputs: { characterName: evil, theme: evil, eras: [evil, "b"], transformation: evil, finale: evil }, newId: (p: string) => `${p}${++n}` });
    doc.captions = { ...doc.captions, enabled: true, cues: [{ id: "c1", text: evil, anchor: { type: "absolute", startFrame: 0 }, startFrame: 0, endFrame: 30, timing: "manual" }] };
    const out = compileComposition(doc, { scale: 0.5, assets: new Map(), fonts: [], gsapFile: "gsap.min.js" } as never);
    const { document } = parseHTML(out.html);
    // Only the compositor's own scripts exist, and none contains a raw tag breakout.
    const benign = instantiateTemplate(getBuiltinTemplate("mascot-story")!, { title: "t", brand: DEFAULT_BRAND, inputs: { characterName: "a", theme: "b", eras: ["c", "d"], transformation: "e", finale: "f" }, newId: (p: string) => `${p}${++n}` });
    const benignScripts = parseHTML(compileComposition(benign, { scale: 0.5, assets: new Map(), fonts: [], gsapFile: "gsap.min.js" } as never).html).document.querySelectorAll("script").length;
    expect(document.querySelectorAll("script").length).toBe(benignScripts);
    for (const s of document.querySelectorAll("script")) expect(s.textContent ?? "").not.toMatch(/<\/?script/i);
    expect([...document.querySelectorAll("[onerror]")]).toHaveLength(0);
    expect([...document.querySelectorAll("img")].every((i) => !/^x$/.test(i.getAttribute("src") ?? ""))).toBe(true);
    expect(out.html).not.toMatch(/url\(http/);
    expect(document.body.textContent).toContain("window.pwned=1"); // shown as text, inert
  });
});

describe("media layers follow the asset's real kind", () => {
  it("draws an image placed in a video slot as an image, and a video in an image slot as a video", () => {
    let n = 0;
    const doc = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === "anime-opening")!, { title: "T", brand: DEFAULT_BRAND, inputs: { song: "song", excerptStart: 0, excerptEnd: 30, title: "X", synopsis: "Y", characters: ["A"], direction: "anime" }, newId: (p) => `${p}${++n}`, sourceDurationSec: 60 });
    const vScene = doc.scenes.find((s) => s.layers.some((l) => l.kind === "video" && l.slot === "media"))!;
    const vLayer = vScene.layers.find((l) => l.kind === "video" && l.slot === "media")!;
    if (vLayer.kind === "video") vLayer.assetId = "still";
    const assets = new Map<string, StagedAsset>([
      ["still", { file: "assets/still.png", kind: "image", width: 1280, height: 720 }],
      ["song", { file: "assets/song.m4a", kind: "audio", durationSec: 60 }],
    ]);
    const { document } = parseHTML(compileComposition(doc, { scale: 0.5, assets, fonts: [], gsapFile: "gsap.min.js" } as never).html);
    const el = document.getElementById(`l-${vScene.id}-${vLayer.id}`)!;
    expect(el.querySelector("video")).toBeNull();
    expect(el.querySelector("img")!.getAttribute("src")).toBe("assets/still.png");

    const { doc: pl } = build("16:9");
    const iScene = pl.scenes.find((s) => s.layers.some((l) => l.kind === "image" && l.assetId === "s1"))!;
    const iLayer = iScene.layers.find((l) => l.kind === "image" && l.assetId === "s1")!;
    const clips = new Map<string, StagedAsset>([["s1", { file: "assets/clip.mp4", kind: "video", durationSec: 8 }]]);
    const html = parseHTML(compileComposition(pl, { scale: 0.5, assets: clips, fonts: [], gsapFile: "gsap.min.js" } as never).html).document;
    const v = html.getElementById(`l-${iScene.id}-${iLayer.id}`)!.querySelector("video")!;
    expect(v.getAttribute("src")).toBe("assets/clip.mp4");
    expect(v.getAttribute("data-media-start")).toBe("0");
  });
});
