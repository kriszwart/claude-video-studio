import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError, createProject, signAssetUrl, enqueueJob, getDb, getTemplateVersion, listProjects, newId, schema } from "@vs/db";
import { AspectRatio, BrandSnapshot, type BudgetPolicy, DEFAULT_BUDGET, SCRIPT_STYLE_IDS } from "@vs/domain";
import { DEFAULT_BRAND, instantiateTemplate, missingRequiredInputs, TemplateDefinition } from "@vs/templates";
import { requireSession } from "@/lib/server/auth";
import { requireClaude } from "@/lib/server/claude";
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
    // Poster: the latest render's thumbnail, else the newest keyframe of the opening scene.
    let posterAssetId = last?.thumbnailAssetId ?? null;
    if (!posterAssetId) {
      const kf = await db.query.jobs.findFirst({ where: and(eq(schema.jobs.projectId, p.id), eq(schema.jobs.type, "keyframes"), eq(schema.jobs.status, "succeeded")), orderBy: (j, { desc }) => desc(j.createdAt) });
      posterAssetId = (kf?.result as { keyframes?: { assetId: string }[] } | null)?.keyframes?.[0]?.assetId ?? null;
    }
    out.push({
      id: p.id,
      title: p.title,
      family: p.family,
      isSample: p.isSample,
      status: p.status,
      updatedAt: p.updatedAt,
      variantLabel: p.variantLabel,
      thumbnailAssetId: last?.thumbnailAssetId ?? null,
      posterUrl: posterAssetId ? signAssetUrl(posterAssetId, s.workspaceId) : null,
      rendered: !!last,
    });
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
  /** Planner effort from the composer's dial (defaults to the planner's own). */
  planEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  /** Narrate with this voice: after planning when planning, otherwise right away. */
  narration: z.object({ voiceId: z.string().min(1).max(120) }).optional(),
  /** Start with the script stage instead of planning: Claude writes a script for approval first. */
  script: z.object({ style: z.enum(SCRIPT_STYLE_IDS), direction: z.string().max(400).default(""), narrated: z.boolean() }).optional(),
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
  const assetDurations = new Map<string, number>();
  for (const f of template.inputs.filter((x) => ["image", "images", "audio", "video", "videos", "subtitle"].includes(x.kind))) {
    const v = input.inputs[f.id];
    for (const id of Array.isArray(v) ? v : v ? [String(v)] : []) {
      const a = await db.query.assets.findFirst({ where: and(eq(schema.assets.id, id), eq(schema.assets.workspaceId, s.workspaceId)) });
      if (!a) throw new AppError(422, "unknown_asset", `An asset selected for "${f.label}" is not available.`);
      if (a.status !== "ready") throw new AppError(409, "asset_not_ready", `"${a.originalName}" is still processing.`);
      if (f.kind === "subtitle" && a.kind !== "document") throw new AppError(422, "invalid_input", `"${a.originalName}" is not a subtitle file.`);
      if ((f.kind === "video" || f.kind === "videos") && a.kind !== "video") throw new AppError(422, "invalid_input", `"${a.originalName}" is not a video.`);
      assetDurations.set(id, Number((a.media as { durationSec?: number }).durationSec ?? 0));
    }
  }
  let brand = { ...DEFAULT_BRAND, name: String(input.inputs.productName ?? "") };
  if (input.brandKitId) {
    const kit = await db.query.brandKits.findFirst({ where: and(eq(schema.brandKits.id, input.brandKitId), eq(schema.brandKits.workspaceId, s.workspaceId)) });
    if (!kit) throw new AppError(422, "unknown_brand_kit", "Brand kit not found.");
    brand = BrandSnapshot.parse({ ...(kit.data as object), brandKitId: kit.id, brandKitVersion: kit.version });
  }
  if (typeof input.inputs.logo === "string" && input.inputs.logo && !brand.logoAssetId) brand = { ...brand, logoAssetId: input.inputs.logo };
  const sourceId = template.program ? String(input.inputs[template.program.sourceInput] ?? "") : template.musicVideo ? String(input.inputs[template.musicVideo.songInput] ?? "") : "";
  let doc: ReturnType<typeof instantiateTemplate>;
  try {
    doc = instantiateTemplate(template, { title: input.title, aspect: input.aspect, brand, inputs: input.inputs, durationSec: input.durationSec, newId, sourceDurationSec: assetDurations.get(sourceId) });
  } catch (e) {
    throw new AppError(422, "invalid_input", e instanceof Error ? e.message : String(e));
  }
  const budget: BudgetPolicy = { ...DEFAULT_BUDGET, ...input.budget };
  // AI planning needs a ready Claude runtime; without it, nothing is created (create without planning instead).
  if (input.plan || input.script) await requireClaude(s.workspaceId);
  const result = await db.transaction(async (tx) => {
    const created = await createProject(tx, { workspaceId: s.workspaceId, doc, templateId: template.id, templateVersion: template.version, family: template.family, budget, action: "created from template" });
    let job = null;
    if (input.script && !template.program && !template.musicVideo) {
      const next = { ...(input.planEffort ? { planEffort: input.planEffort } : {}), ...(input.narration ? { voiceId: input.narration.voiceId } : {}) };
      job = (await enqueueJob(tx, { workspaceId: s.workspaceId, projectId: created.project.id, revisionId: created.revision.id, type: "write_script", input: { style: input.script.style, direction: input.script.direction, narrated: input.script.narrated, targetDurationSec: input.durationSec ?? template.duration.defaultSec, next }, idempotencyKey: idem ? `script:${idem}` : null })).job;
    } else if (input.plan) {
      job = (await enqueueJob(tx, { workspaceId: s.workspaceId, projectId: created.project.id, revisionId: created.revision.id, type: "plan", input: { baseRevisionId: created.revision.id, targetDurationSec: input.durationSec ?? template.duration.defaultSec, ...(input.planEffort ? { effort: input.planEffort } : {}), ...(input.narration ? { narration: input.narration } : {}) }, idempotencyKey: idem ? `plan:${idem}` : null })).job;
    } else if (input.narration && !template.program && !template.musicVideo) {
      await enqueueJob(tx, { workspaceId: s.workspaceId, projectId: created.project.id, revisionId: created.revision.id, type: "tts", input: { voiceId: input.narration.voiceId, rate: 1, fit: "extend" }, idempotencyKey: idem ? `tts:${idem}` : null });
    }
    // Talking-head projects start transcript-first: import the supplied subtitles, or
    // transcribe with whatever provider is available (the job fails clearly if none is).
    let transcribeJob = null;
    if (template.program) {
      const sub = template.program.transcriptInput ? String(input.inputs[template.program.transcriptInput] ?? "") : "";
      transcribeJob = (await enqueueJob(tx, { workspaceId: s.workspaceId, projectId: created.project.id, revisionId: created.revision.id, type: "transcribe", input: { assetId: sourceId, subtitleAssetId: sub || undefined, provider: "auto" }, idempotencyKey: idem ? `transcribe:${idem}` : null })).job;
    }
    // Music videos: analyse the song, then build section scenes and markers from it.
    if (template.musicVideo) {
      const input = template.family === "music-video" ? { build: "music-video", density: "downbeats" } : { density: "downbeats", fit: ["downbeat", "section"] };
      transcribeJob = (await enqueueJob(tx, { workspaceId: s.workspaceId, projectId: created.project.id, revisionId: created.revision.id, type: "analyze_music", input, idempotencyKey: idem ? `analyze:${idem}` : null })).job;
    }
    await tx.insert(schema.analyticsEvents).values({ workspaceId: s.workspaceId, name: "project_created", props: { family: template.family, template: template.id, plan: input.plan } });
    return { project: created.project, job, transcribeJob };
  });
  return json({ ...(await projectView(result.project.id, s.workspaceId)), planJobId: result.job?.id ?? null, transcribeJobId: result.transcribeJob?.id ?? null }, 201);
});
