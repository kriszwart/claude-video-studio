import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate } from "@vs/templates";
import { issuesFrom, smallScreens } from "../src/handlers/quality";

let n = 0;
const launch = (aspect: "16:9" | "9:16" | "1:1") =>
  instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === "product-launch")!, {
    title: "T",
    brand: DEFAULT_BRAND,
    aspect,
    inputs: { productName: "Tidewave", promise: "Plan less", problem: "Too many tabs", benefits: ["Fast"], cta: "Try it", screenshots: ["ast_shot1", "ast_shot2"] },
    newId: (p) => `${p}${++n}`,
  });

describe("readable on a phone", () => {
  it("the built-in launch layouts show product screens big enough in every size", () => {
    for (const a of ["16:9", "9:16", "1:1"] as const) expect(smallScreens(launch(a))).toEqual([]);
  });

  it("flags a product screen shrunk into a corner", () => {
    const doc = launch("16:9");
    const scene = doc.scenes.find((s) => s.layers.some((l) => l.kind === "image" && (l as { frame?: string }).frame === "laptop"))!;
    const layer = scene.layers.find((l) => l.kind === "image")!;
    layer.box = { x: 0.7, y: 0.7, w: 0.25, h: 0.25 };
    expect(smallScreens(doc)).toEqual([expect.objectContaining({ code: "ui_too_small", sceneId: scene.id, layerId: layer.id })]);
  });

  it("judges text size on the frame's short side, and tells shrunk text from text designed small", () => {
    const doc = launch("9:16");
    const s = doc.scenes[1]!;
    const [a, b] = s.layers.filter((l) => l.kind === "text");
    const id = (l: { id: string }) => `l-${s.id}-${l.id}`;
    // A 540×960 capture: 14 px on the short side is 28 at 1080 (fine), 12 px is 24 (too small).
    const report = { overflow: [], missingFonts: [], sizes: [{ id: id(a!), px: 12, ratio: 0.6 }, { id: id(b!), px: 12, ratio: 1 }, { id: `l-${s.id}-x`, px: 14, ratio: 1 }] };
    const issues = issuesFrom(doc, report, 960, 540).filter((i) => /text_/.test(i.code));
    expect(issues.map((i) => [i.code, i.layerId, i.repairable])).toEqual([["text_too_small", a!.id, true], ["text_small_on_phone", b!.id, false]]);
    expect(issuesFrom(doc, { ...report, sizes: [{ id: id(b!), px: 14, ratio: 1 }] }, 960, 540).filter((i) => /text_/.test(i.code))).toEqual([]);
  });
});
