import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError, createProject, enqueueJob, getDb, getProviderSecret, getTemplateVersion, listProjects, newId, schema } from "@vs/db";
import { AspectRatio, BrandSnapshot, type BudgetPolicy, DEFAULT_BUDGET } from "@vs/domain";
import { DEFAULT_BRAND, instantiateTemplate, missingRequiredInputs, TemplateDefinition } from "@vs/templates";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { projectView } from "@/lib/server/projects";

export const GET = route(async (req) => {
  const s = await requireSession();
  const status = new URL(req.url).searchParams.get("status") === "archived" ? "archived" : "active";
  const rows = await listProjects(getDb(), s.workspaceId, status);
  const db = getDb();
  const out = [];
  for (const p of rows) {
    const last = await db.query.exportsTable.findFirst({ where: eq(schema.exportsTable.projectId, p.id), orderBy: (e, { desc }) => desc(e.createdAt) });
    out.push({ id: p.id, title: p.title, family: p.family, isSample: p.isSample, status: p.status, updatedAt: p.updatedAt, variantLabel: p.variantLabel, thumbnailAssetId: last?.thumbnailAssetId ?? null });
  }
  return json({ projects: out });
});

const Create = z.object({
  templateId: z.string().max(80),
  templateVersion: z.number().int().positive().optional(),
  title: z.string().min(1).max(160),
  aspect: AspectRatio.optional(),
  inputs: z.record(z.string(), z.union([z.string().max(4000), z.number(), z.boolean(), z.array(z.string().max(400)).max(20)])).default({}),
  brandKitId: z.string().max(64).optional(),
  durationSec: z.number().positive().max(300).optional(),
  plan: z.boolean().default(false),
  budget: z.object({ projectCeilingMicros: z.number().int().min(0), operationCeilingMicros: z.number().int().min(0), unknownPriceRequestsAuthorized: z.number().int().min(0) }).partial().optional(),
});

export const POST = route(async (req) => {
  const s = await requireSession();
  const input = await body(req, Create);
  const idem = idempotencyKey(req);
  const db = getDb();
  const { version } = await getTemplateVersion(db, s.workspaceId, input.templateId, input.templateVersion);
  const template = TemplateDefinition.parse(version.definition);
  const missing = missingRequiredInputs(template, input.inputs);
  if (missing.length) throw new AppError(422, "missing_inputs", `Required inputs are missing: ${missing.join(", ")}.`);
  // Asset inputs must belong to this workspace.
  for (const f of template.inputs.filter((x) => ["image", "images", "audio", "video"].includes(x.kind))) {
    const v = input.inputs[f.id];
    for (const id of Array.isArray(v) ? v : v ? [String(v)] : []) {
      const a = await db.query.assets.findFirst({ where: and(eq(schema.assets.id, id), eq(schema.assets.workspaceId, s.workspaceId)) });
      if (!a) throw new AppError(422, "unknown_asset", `An asset selected for "${f.label}" is not available.`);
      if (a.status !== "ready") throw new AppError(409, "asset_not_ready", `"${a.originalName}" is still processing.`);
    }
  }
  let brand = { ...DEFAULT_BRAND, name: String(input.inputs.productName ?? "") };
  if (input.brandKitId) {
    const kit = await db.query.brandKits.findFirst({ where: and(eq(schema.brandKits.id, input.brandKitId), eq(schema.brandKits.workspaceId, s.workspaceId)) });
    if (!kit) throw new AppError(422, "unknown_brand_kit", "Brand kit not found.");
    brand = BrandSnapshot.parse({ ...(kit.data as object), brandKitId: kit.id, brandKitVersion: kit.version });
  }
  if (typeof input.inputs.logo === "string" && input.inputs.logo && !brand.logoAssetId) brand = { ...brand, logoAssetId: input.inputs.logo };
  const doc = instantiateTemplate(template, { title: input.title, aspect: input.aspect, brand, inputs: input.inputs, durationSec: input.durationSec, newId });
  const budget: BudgetPolicy = { ...DEFAULT_BUDGET, ...input.budget };
  const result = await db.transaction(async (tx) => {
    const created = await createProject(tx, { workspaceId: s.workspaceId, doc, templateId: template.id, templateVersion: template.version, family: template.family, budget, action: "created from template" });
    let job = null;
    if (input.plan) {
      if (!(await getProviderSecret(tx, s.workspaceId, "anthropic"))) {
        throw new AppError(412, "credentials_missing", "Claude is not configured, so the storyboard can't be planned with AI.", "Add an Anthropic API key in Settings, or create the project without AI planning and edit it manually.");
      }
      job = (await enqueueJob(tx, { workspaceId: s.workspaceId, projectId: created.project.id, revisionId: created.revision.id, type: "plan", input: { baseRevisionId: created.revision.id, targetDurationSec: input.durationSec ?? template.duration.defaultSec }, idempotencyKey: idem ? `plan:${idem}` : null })).job;
    }
    await tx.insert(schema.analyticsEvents).values({ workspaceId: s.workspaceId, name: "project_created", props: { family: template.family, template: template.id, plan: input.plan } });
    return { project: created.project, job };
  });
  return json({ ...(await projectView(result.project.id, s.workspaceId)), planJobId: result.job?.id ?? null }, 201);
});
