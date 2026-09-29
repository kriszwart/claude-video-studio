import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, checkTemplateIndependence, DEFAULT_BRAND, instantiateTemplate, templateFromProject } from "../src";

let n = 0;
const doc = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === "product-launch")!, {
  title: "Orig",
  brand: { ...DEFAULT_BRAND, logoAssetId: "ast_logo" },
  inputs: { productName: "Tidewave", promise: "P", problem: "H", benefits: ["B1", "B2"], screenshots: ["ast_s1", "ast_s2"], logo: "ast_logo", cta: "Go", music: "ast_music" },
  newId: (p) => `${p}${++n}`,
});

describe("save as template", () => {
  const textVars = doc.scenes.flatMap((s) => s.layers.filter((l) => l.kind === "text").map((l) => ({ sceneId: s.id, layerId: l.id })));
  const r = templateFromProject(doc, { name: "Mine", description: "", textVariables: textVars, includeAssetIds: [], source: { projectId: "p", revisionId: "r" } });

  it("turns private media into slots and the brand logo into the logo input", () => {
    const json = JSON.stringify(r.definition);
    for (const a of ["ast_s1", "ast_s2", "ast_logo", "ast_music"]) expect(json).not.toContain(a);
    const end = r.definition.scenes.find((s) => s.layout === "end-card")!;
    expect(end.layers.find((l) => l.kind === "image")).toMatchObject({ asset: "{{logo}}" });
    expect(r.definition.inputs.filter((i) => i.id === "logo")).toHaveLength(1);
    expect(r.definition.audio.musicInput).toBeTruthy();
  });

  it("keeps approved claims as fact inputs and instantiates a second product independently", () => {
    expect(r.definition.inputs.some((i) => i.kind === "facts")).toBe(true);
    const check = checkTemplateIndependence(r.definition, doc, []);
    expect(check.ok).toBe(true);
    const second = instantiateTemplate(r.definition, { title: "Second", brand: DEFAULT_BRAND, inputs: { logo: "ast_new_logo" }, newId: (p) => `${p}x${++n}` });
    const end = second.scenes.find((s) => s.layout === "end-card")!;
    expect(end.layers.find((l) => l.kind === "image")).toMatchObject({ assetId: "ast_new_logo" });
    const benefit = second.scenes.find((s) => s.layout === "benefit-list")!.layers.find((l) => l.kind === "text" && l.approvedFactId);
    expect(benefit && benefit.kind === "text" && benefit.text).toBe("B1");
  });

  it("packages explicitly included media", () => {
    const withMusic = templateFromProject(doc, { name: "M", description: "", textVariables: [], includeAssetIds: ["ast_music"], source: { projectId: "p", revisionId: "r" } });
    expect(JSON.stringify(withMusic.definition)).toContain("ast_music");
  });
});
