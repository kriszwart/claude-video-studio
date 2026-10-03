import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate } from "@vs/templates";
import { compileComposition, type StagedAsset } from "../src";

const ctxFor = (_doc: unknown) => ({
  scale: 1,
  assets: new Map<string, StagedAsset>([
    ["s1", { file: "assets/s1.png", kind: "image", width: 1440, height: 900 }],
    ["s2", { file: "assets/s2.png", kind: "image", width: 1440, height: 900 }],
    ["logo", { file: "assets/logo.png", kind: "image" }],
  ]),
  fonts: [{ family: "Space Grotesk", weight: 700, file: "fonts/sg.woff2" }, { family: "Inter", weight: 400, file: "fonts/i.woff2" }],
  gsapFile: "vendor/gsap.min.js",
  audioMix: { file: "audio/mix.wav" },
});

/** Product launch in a calm style (no shader effects, so no graphics backend is needed). */
function build(aspect: "16:9" | "9:16" | "1:1", overrides: Record<string, unknown> = {}, motionIntensity = 0.3) {
  let n = 0;
  const doc = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === "product-launch")!, {
    title: "T",
    aspect,
    profile: { motionIntensity },
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
    expect(build("16:9").doc.scenes.map((s) => s.recipeSlot)).toEqual(["hook", "reveal", "benefits", "demo", "cta"]);
    const withProof = build("16:9", { proof: ["Cut planning time in half for our team"], proofSource: "Pilot customer" }).doc;
    expect(withProof.scenes.map((s) => s.recipeSlot)).toEqual(["hook", "reveal", "benefits", "demo", "proof", "cta"]);
    const q = withProof.scenes[4]!.layers.find((l) => l.kind === "text" && l.role === "quote");
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

describe("motion-grammar transitions", () => {
  it("compiles every transition, with overlays only for tiles and colour field, and a camera push per scene", () => {
    for (const type of ["flythrough", "portal", "fold", "tiles", "colorfield"] as const) {
      const { doc } = build("16:9");
      doc.scenes[1]!.transitionIn = { type, durationFrames: 18 };
      const out = compileComposition(doc, { scale: 0.5, assets: new Map(), fonts: [], gsapFile: "gsap.min.js" } as never);
      const { document } = parseHTML(out.html);
      const overlay = document.getElementById(`tr-${doc.scenes[1]!.id}`);
      if (type === "tiles") expect(overlay!.querySelectorAll(".tile").length).toBe(24);
      else if (type === "colorfield") expect(overlay).not.toBeNull();
      else expect(overlay).toBeNull();
      expect(document.getElementById(`s-${doc.scenes[1]!.id}-cam`)).not.toBeNull();
      const script = [...document.querySelectorAll("script")].map((s) => s.textContent).join("\n");
      expect(script).toContain(`#s-${doc.scenes[0]!.id}-cam`);
      if (type === "flythrough") expect(script).toMatch(/blur\(12px\)/);
      if (type === "portal") expect(script).toMatch(/circle\(0% at 50% 50%\)/);
    }
  });

  it("a screen demo scene holds the screenshot until steps are planned, then films it with camera and cursor", () => {
    const { doc } = build("16:9");
    const demo = doc.scenes.find((s) => s.recipeSlot === "demo")!;
    expect(demo.demo).toMatchObject({ layerId: demo.layers.find((l) => l.slot === "media")!.id, steps: [] });
    expect(build("16:9", { screenshots: [] }).doc.scenes.some((s) => s.recipeSlot === "demo")).toBe(false);
    const html0 = compileComposition(doc, ctxFor(doc)).html;
    expect(html0).not.toContain(`l-${demo.id}-${demo.demo!.layerId}-cam`);
    demo.demo!.steps = [
      { x: 0.3, y: 0.4, zoom: 2, atFrames: 40, action: "click", label: "New invoice" },
      { x: 0.6, y: 0.5, zoom: 2.5, atFrames: 100, action: "move", label: "" },
    ];
    const html = compileComposition(doc, ctxFor(doc)).html;
    const lid = `l-${demo.id}-${demo.demo!.layerId}`;
    expect(html).toContain(`id="${lid}-cam"`);
    expect(html).toContain(`id="${lid}-cur"`);
    expect(html.match(new RegExp(`id="${lid}-rip\\d+"`, "g"))).toHaveLength(1); // only the click ripples
    // The scene's slow push is off; its own camera is set every frame it moves.
    expect(html).not.toContain(`tl.fromTo("#${demo.id}-cam"`);
    expect((html.match(new RegExp(`tl\\.set\\("#${lid}-cam"`, "g")) ?? []).length).toBeGreaterThan(40);
  });
});


describe("screen demo stacking", () => {
  it("keeps the scene's text above the zooming screenshot, and the screenshot above decoration", () => {
    const { doc } = build("16:9");
    const scene = doc.scenes[1]!;
    const media = scene.layers.find((l) => l.kind === "image")!;
    scene.layout = "screen-demo";
    scene.demo = { layerId: media.id, zoomOut: true, steps: [{ x: 0.5, y: 0.5, zoom: 2.5, atFrames: 10, action: "click", label: "Go" }] } as never;
    const assets = new Map<string, StagedAsset>([
      ["s1", { file: "assets/s1.png", kind: "image", width: 1440, height: 900 }],
      ["s2", { file: "assets/s2.png", kind: "image", width: 1440, height: 900 }],
      ["logo", { file: "assets/logo.png", kind: "image" }],
    ]);
    const out = compileComposition(doc, { scale: 1, assets, fonts: [{ family: "Space Grotesk", weight: 700, file: "fonts/sg.woff2" }], gsapFile: "vendor/gsap.min.js", audioMix: null } as never);
    const { document } = parseHTML(out.html);
    const z = (el: Element | null) => Number(/z-index:\s*(-?\d+)/.exec(el?.getAttribute("style") ?? "")?.[1]);
    const demoLayer = document.querySelector(".layer.demo");
    const sceneEl = demoLayer!.closest("[id]")!.parentElement!;
    const texts = [...document.querySelectorAll(".layer")].filter((el) => el !== demoLayer && el.querySelector(".fit") && sceneEl.contains(el));
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(z(t)).toBeGreaterThan(z(demoLayer));
    expect(z(demoLayer)).toBeGreaterThanOrEqual(10);
  });
});

describe("screen demo text while zoomed", () => {
  const compileDemo = (backing: "none" | "translucent") => {
    const { doc } = build("16:9");
    const scene = doc.scenes[1]!;
    const media = scene.layers.find((l) => l.kind === "image")!;
    scene.layout = "screen-demo";
    scene.demo = { layerId: media.id, zoomOut: true, steps: [{ x: 0.5, y: 0.5, zoom: 2.5, atFrames: 10, action: "click", label: "Go" }] } as never;
    const headline = scene.layers.find((l) => l.kind === "text" && l.role === "headline")!;
    if (headline.kind === "text") headline.style = { ...headline.style, backing };
    const assets = new Map<string, StagedAsset>([
      ["s1", { file: "assets/s1.png", kind: "image", width: 1440, height: 900 }],
      ["s2", { file: "assets/s2.png", kind: "image", width: 1440, height: 900 }],
      ["logo", { file: "assets/logo.png", kind: "image" }],
    ]);
    const out = compileComposition(doc, { scale: 1, assets, fonts: [{ family: "Space Grotesk", weight: 700, file: "fonts/sg.woff2" }], gsapFile: "vendor/gsap.min.js", audioMix: null } as never);
    const fadedOut = (out.html.match(/tl\.to\("([^"]+)",\{opacity:0,duration:0\.3/g) ?? []).join(" ");
    return { fadedOut, headlineSel: `#l-${scene.id}-${headline.id}` };
  };
  it("lets text step aside during the close-up, unless the owner gave it a backing to sit on the screenshot", () => {
    const plain = compileDemo("none");
    expect(plain.fadedOut).toContain(plain.headlineSel);
    const backed = compileDemo("translucent");
    expect(backed.fadedOut).not.toContain(backed.headlineSel);
  });
});

describe("non-breaking spaces", () => {
  it("keep words joined by a non-breaking space in one word, so a line never breaks there", () => {
    const { doc } = build("16:9");
    const cta = doc.scenes.at(-1)!;
    const label = cta.layers.find((l) => l.kind === "text")!;
    if (label.kind === "text") label.text = "Call 01472 250390 today";
    const assets = new Map<string, StagedAsset>([
      ["s1", { file: "assets/s1.png", kind: "image", width: 1440, height: 900 }],
      ["s2", { file: "assets/s2.png", kind: "image", width: 1440, height: 900 }],
      ["logo", { file: "assets/logo.png", kind: "image" }],
    ]);
    const out = compileComposition(doc, { scale: 1, assets, fonts: [{ family: "Space Grotesk", weight: 700, file: "fonts/sg.woff2" }], gsapFile: "vendor/gsap.min.js", audioMix: null } as never);
    const { document } = parseHTML(out.html);
    const words = [...document.querySelectorAll(`#l-${cta.id}-${label.id} .w`)].map((w) => w.textContent);
    expect(words).toEqual(["Call", "01472 250390", "today"]);
  });
});

describe("scrim shape", () => {
  it("draws one smooth gradient from clear at the top to the colour's own strength at the bottom", () => {
    const { doc } = build("16:9");
    const scene = doc.scenes[0]!;
    scene.layers.push({ id: "sc", slot: "decor", hidden: false, kind: "shape", shape: "scrim", color: "#000000c0", box: { x: 0, y: 0.4, w: 1, h: 0.6 }, animation: { in: "fade", delayFrames: 0, loop: "none" } } as never);
    const assets = new Map<string, StagedAsset>([
      ["s1", { file: "assets/s1.png", kind: "image", width: 1440, height: 900 }],
      ["s2", { file: "assets/s2.png", kind: "image", width: 1440, height: 900 }],
      ["logo", { file: "assets/logo.png", kind: "image" }],
    ]);
    const out = compileComposition(doc, { scale: 1, assets, fonts: [{ family: "Space Grotesk", weight: 700, file: "fonts/sg.woff2" }], gsapFile: "vendor/gsap.min.js", audioMix: null } as never);
    const { document } = parseHTML(out.html);
    const style = document.querySelector(`#l-${scene.id}-sc`)?.getAttribute("style") ?? "";
    expect(style).toContain("linear-gradient(180deg,rgba(0,0,0,0) 0%");
    expect(style).toContain("rgba(0,0,0,0.753) 100%");
    expect(style).not.toContain("border-radius");
  });
});

describe("text before a crossfade", () => {
  it("eases the outgoing scene's text out before the dissolve starts, so two headlines never overlap", () => {
    const { doc } = build("16:9");
    doc.scenes[1]!.transitionIn = { type: "fade", durationFrames: 15 };
    const assets = new Map<string, StagedAsset>([
      ["s1", { file: "assets/s1.png", kind: "image", width: 1440, height: 900 }],
      ["s2", { file: "assets/s2.png", kind: "image", width: 1440, height: 900 }],
      ["logo", { file: "assets/logo.png", kind: "image" }],
    ]);
    const out = compileComposition(doc, { scale: 1, assets, fonts: [{ family: "Space Grotesk", weight: 700, file: "fonts/sg.woff2" }], gsapFile: "vendor/gsap.min.js", audioMix: null } as never);
    const first = doc.scenes[0]!;
    const headline = first.layers.find((l) => l.kind === "text" && l.role !== "kicker")!;
    const sceneEnd = first.durationFrames / 30, overlapStart = (first.durationFrames - 15) / 30;
    const fades = [...out.html.matchAll(/tl\.fromTo\("([^"]+)",\{opacity:1\},\{opacity:0,duration:([\d.]+)[^}]*\},([\d.]+)\)/g)].filter((m) => m[1]!.includes(`#l-${first.id}-${headline.id}`));
    expect(fades.length).toBeGreaterThan(0);
    const [, , dur, at] = fades[0]!;
    expect(Number(at) + Number(dur)).toBeLessThanOrEqual(overlapStart + 0.04);
    expect(Number(at)).toBeLessThan(sceneEnd);
  });
});

describe("shader transitions", () => {
  // A stand-in Skia backend: records what the compiler asks it to draw.
  const asked: { component: string; params: Record<string, unknown>; start: number; dur: number }[] = [];
  const graphics = (layer: { component: string; params: Record<string, unknown>; id: string }, info: { sceneStartSec: number; sceneDurationSec: number }) => {
    asked.push({ component: layer.component, params: layer.params, start: info.sceneStartSec, dur: info.sceneDurationSec });
    return { html: `<canvas id="gfx-${layer.id}"></canvas>`, script: "", scriptSrcs: ["vendor/vs-skia.js"] };
  };
  const lively = () => {
    let n = 0;
    return instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === "product-launch")!, {
      title: "T",
      brand: { ...DEFAULT_BRAND, name: "Acme", logoAssetId: "logo" },
      profile: { motionIntensity: 0.8 },
      inputs: { productName: "Acme", promise: "P", problem: "H", benefits: ["One"], proof: ["Q"], screenshots: ["s1", "s2"], logo: "logo", cta: "Buy", music: "m" },
      newId: (p) => `${p}${++n}`,
    });
  };

  it("masks the real scenes frame by frame and asks Skia for the light, over exactly the overlap", () => {
    asked.length = 0;
    const doc = lively();
    expect(doc.scenes.map((s) => s.transitionIn.type)).toEqual(["cut", "liquid", "fade", "lens", "grain", "morph"]);
    const out = compileComposition(doc, { ...ctxFor(doc), graphics } as never);
    expect(out.warnings.filter((w) => /shader light/.test(w))).toEqual([]);
    const tr = asked.filter((a) => a.component.startsWith("tr-"));
    expect(tr.map((a) => a.component)).toEqual(["tr-liquid", "tr-lens", "tr-grain", "tr-morph"]);
    for (const [k, type] of ["liquid", "lens", "grain", "morph"].entries()) {
      const i = doc.scenes.findIndex((s) => s.transitionIn.type === type);
      const st = out.timeline.scenes[i]!;
      expect(tr[k]!.start).toBeCloseTo(st.start / 30, 2);
      expect(tr[k]!.dur).toBeCloseTo(st.overlapIn / 30, 2);
      expect(tr[k]!.params.frames).toBe(st.overlapIn);
      expect(String(tr[k]!.params.colors).split(",")).toHaveLength(3);
      expect(out.html).toContain(`id="trx-${doc.scenes[i]!.id}"`);
    }
    const liquid = doc.scenes[1]!;
    // One clip polygon per transition frame, then the clip is cleared.
    const sets = out.html.match(new RegExp(`tl\\.set\\("#s-${liquid.id}",\\{clipPath:"polygon`, "g")) ?? [];
    expect(sets).toHaveLength(liquid.transitionIn.durationFrames);
    expect(out.html).toContain(`tl.set("#s-${liquid.id}",{clipPath:"none",filter:"none",scale:1}`);
    // Pixel work through SVG filters: liquid displacement, grain dissolve and colour fringes.
    expect(out.html).toMatch(/<feDisplacementMap id="fx-[^"]+-d"/);
    expect(out.html).toMatch(/<filter id="fx-[^"]+-in"[^>]*>.*<feTurbulence.*<feComposite in="sp" in2="m" operator="in"\/>/s);
    // Lens: a growing circle; morph: the scenes swap under full cover.
    expect(out.html).toMatch(/clipPath:"circle\(/);
    const morph = doc.scenes[5]!;
    expect(out.html).toMatch(new RegExp(`tl\\.set\\("#s-${morph.id}",\\{opacity:0\\}`));
    // Every set is a quarter frame early, so no frame ever shows the previous value.
    const times = [...out.html.matchAll(/tl\.set\("#s-[^"]+",\{clipPath:"polygon[^}]*\},([\d.]+)\);/g)].map((m) => Number(m[1]));
    for (const t of times) expect(Math.abs(((t * 30) % 1) - 0.75)).toBeLessThan(0.01);
  });

  it("without a Skia backend the scenes still transition, with a warning that the light is missing", () => {
    const { doc } = build("16:9");
    doc.scenes[1]!.transitionIn = { type: "lens", durationFrames: 16 };
    const out = compileComposition(doc, ctxFor(doc) as never);
    expect(out.html).toMatch(/clipPath:"circle\(/);
    expect(out.warnings.some((w) => /lens transition .* without its shader light/.test(w))).toBe(true);
  });
});
