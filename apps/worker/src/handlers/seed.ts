import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createProject, getDb, getTemplateVersion, newId, schema } from "@vs/db";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate, TemplateDefinition } from "@vs/templates";
import { registerFile, type Handler } from "../context";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "sample");

/** First run: a clearly labelled sample product-launch project built from the CC0 fixtures. */
export const seedSample: Handler = async (ctx) => {
  const db = getDb();
  const ws = ctx.job.workspaceId;
  const existing = await db.query.projects.findFirst({ where: and(eq(schema.projects.workspaceId, ws), eq(schema.projects.isSample, true)) });
  if (existing) return { projectId: existing.id, existed: true };
  await ctx.stage("importing sample assets");
  const files: [string, "image" | "audio"][] = [
    ["tidewave-dashboard.png", "image"],
    ["tidewave-insights.png", "image"],
    ["tidewave-mobile.png", "image"],
    ["logo-tidewave.png", "image"],
    ["music-launch-bed.m4a", "audio"],
  ];
  const ids: Record<string, string> = {};
  for (const [f, kind] of files) {
    const dup = await db.query.assets.findFirst({ where: and(eq(schema.assets.workspaceId, ws), eq(schema.assets.originalName, `SAMPLE-${f}`), eq(schema.assets.isSample, true)) });
    ids[f] = dup?.id ?? (await registerFile(ws, join(FIXTURES, f), { kind, originalName: `SAMPLE-${f}`, isSample: true, provenance: { source: "sample-fixture", license: "CC0 (generated for a fictional brand)", file: `fixtures/sample/${f}` } })).id;
  }
  const brand = { ...DEFAULT_BRAND, name: "Tidewave (sample)", logoAssetId: ids["logo-tidewave.png"], colors: { ...DEFAULT_BRAND.colors, primary: "#0891b2", secondary: "#1e1b4b", accent: "#22d3ee" } };
  await db.insert(schema.brandKits).values({ id: newId("bk"), workspaceId: ws, name: "Tidewave (sample brand)", data: brand }).onConflictDoNothing();
  const { version } = await getTemplateVersion(db, ws, "product-launch");
  const template = TemplateDefinition.parse(version.definition ?? BUILTIN_TEMPLATES[0]);
  const doc = instantiateTemplate(template, {
    title: "Tidewave launch — SAMPLE",
    brand,
    inputs: {
      productName: "Tidewave",
      promise: "Plans your day around deep work, automatically.",
      problem: "Your calendar decides your day. It shouldn't.",
      benefits: ["Protects two focus blocks every day", "Moves meetings without the back-and-forth", "Weekly insight into where time went"],
      screenshots: [ids["tidewave-dashboard.png"]!, ids["tidewave-insights.png"]!, ids["tidewave-mobile.png"]!],
      logo: ids["logo-tidewave.png"],
      cta: "Try Tidewave free",
      destinationUrl: "tidewave.example",
      music: ids["music-launch-bed.m4a"],
      audience: "For busy product teams",
      notes: "SAMPLE DATA: fictional product and generated assets.",
    },
    newId,
  });
  const { project } = await createProject(db, { workspaceId: ws, doc, templateId: template.id, templateVersion: template.version, family: template.family, isSample: true, action: "sample project" });
  return { projectId: project.id };
};
