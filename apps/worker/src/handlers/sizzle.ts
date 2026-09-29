import { and, eq } from "drizzle-orm";
import { AppError, createProject, getCollection, getDb, getTemplateVersion, getTranscript, JobError, newId, schema } from "@vs/db";
import { AspectRatio, BrandSnapshot, DEFAULT_BUDGET } from "@vs/domain";
import { measureQuoteCuts } from "@vs/rendering";
import { DEFAULT_BRAND, instantiateTemplate, TemplateDefinition, type SizzleQuote } from "@vs/templates";
import { z } from "zod";
import { resolveAssets, type Handler } from "../context";

const Input = z.object({
  collectionId: z.string().max(64),
  title: z.string().min(1).max(160),
  aspect: AspectRatio.optional(),
  brandKitId: z.string().max(64).optional(),
  inputs: z.record(z.string(), z.union([z.string().max(4000), z.array(z.string().max(400)).max(20)])).default({}),
  quotes: z
    .array(z.object({ transcriptId: z.string().max(64), segmentIds: z.array(z.string().max(40)).min(1).max(40), theme: z.string().max(40).default(""), speaker: z.string().max(80).optional() }))
    .min(1)
    .max(24),
});

/**
 * Build a P3 event sizzle from quotes selected in a collection. Each quote is the verbatim
 * run of transcript segments; its clip is cut in the pauses around it, measured from the
 * recording's audio so the first and last words are complete (FR-16, A19). Creates a new
 * project; the quote integrity check runs again on save.
 */
export const buildSizzle: Handler = async (ctx) => {
  const db = getDb();
  const input = Input.parse(ctx.job.input);
  const ws = ctx.job.workspaceId;
  const { collection } = await getCollection(db, input.collectionId, ws);
  await ctx.stage("measuring cuts");
  const quotes: (SizzleQuote & { report: unknown })[] = [];
  for (const [n, sel] of input.quotes.entries()) {
    const t = await getTranscript(db, sel.transcriptId, ws);
    const inCollection = await db.query.transcriptSegments.findFirst({ where: and(eq(schema.transcriptSegments.transcriptId, t.id), eq(schema.transcriptSegments.collectionId, collection.id)) });
    if (!inCollection) throw new JobError("invalid_input", "A selected quote isn't part of this collection.", false);
    const idx = sel.segmentIds.map((id) => t.segments.findIndex((s) => s.id === id)).sort((a, b) => a - b);
    if (idx.some((i) => i < 0)) throw new JobError("invalid_input", "A selected quote refers to transcript text that doesn't exist.", false);
    if (idx.some((v, i) => i > 0 && v !== idx[i - 1]! + 1)) throw new JobError("invalid_input", "Each quote must be a continuous passage.", false);
    const segs = idx.map((i) => t.segments[i]!);
    const prev = t.segments[idx[0]! - 1];
    const next = t.segments[idx.at(-1)! + 1];
    const asset = await db.query.assets.findFirst({ where: and(eq(schema.assets.id, t.assetId), eq(schema.assets.workspaceId, ws)) });
    if (!asset || asset.kind !== "video") throw new JobError("invalid_input", "Quotes for a sizzle reel must come from video recordings.", false);
    const file = (await resolveAssets(ws, [asset.id])).get(asset.id)!;
    const duration = Number((asset.media as { durationSec?: number }).durationSec ?? Infinity);
    const cuts = await measureQuoteCuts(file.path, { speechInSec: segs[0]!.startSec, speechOutSec: segs.at(-1)!.endSec, prevEndSec: prev?.endSec ?? 0, nextStartSec: next?.startSec ?? duration });
    const item = await db.query.collectionItems.findFirst({ where: and(eq(schema.collectionItems.collectionId, collection.id), eq(schema.collectionItems.assetId, asset.id)) });
    quotes.push({
      collectionId: collection.id,
      assetId: asset.id,
      transcriptId: t.id,
      sourceName: item?.sourceName ?? asset.originalName,
      segmentIds: segs.map((s) => s.id),
      segments: segs.map((s) => ({ startSec: s.startSec, endSec: s.endSec, text: s.text })),
      clipInSec: Math.min(cuts.in.timeSec, segs[0]!.startSec),
      clipOutSec: Math.min(duration, Math.max(cuts.out.timeSec, segs.at(-1)!.endSec)),
      theme: sel.theme,
      speaker: sel.speaker,
      cutLevelsDb: { in: cuts.in.levelDb, out: cuts.out.levelDb },
      report: { in: cuts.in, out: cuts.out },
    });
    await ctx.stage("measuring cuts", (n + 1) / input.quotes.length);
  }

  await ctx.stage("building reel");
  const { version } = await getTemplateVersion(db, ws, "event-sizzle");
  const template = TemplateDefinition.parse(version.definition);
  let brand = { ...DEFAULT_BRAND, name: String(input.inputs.eventName ?? "") };
  if (input.brandKitId) {
    const kit = await db.query.brandKits.findFirst({ where: and(eq(schema.brandKits.id, input.brandKitId), eq(schema.brandKits.workspaceId, ws)) });
    if (!kit) throw new JobError("invalid_input", "Brand kit not found.", false);
    brand = BrandSnapshot.parse({ ...(kit.data as object), brandKitId: kit.id, brandKitVersion: kit.version });
  }
  for (const key of ["logo", "music"] as const) {
    const id = input.inputs[key];
    if (typeof id === "string" && id) {
      const a = await db.query.assets.findFirst({ where: and(eq(schema.assets.id, id), eq(schema.assets.workspaceId, ws)) });
      if (!a || a.status !== "ready") throw new JobError("invalid_input", `The selected ${key} isn't available.`, false);
    }
  }
  if (typeof input.inputs.logo === "string" && input.inputs.logo && !brand.logoAssetId) brand = { ...brand, logoAssetId: input.inputs.logo };
  let doc;
  try {
    doc = instantiateTemplate(template, { title: input.title, aspect: input.aspect, brand, inputs: input.inputs, newId, quotes });
  } catch (e) {
    throw new JobError("invalid_input", e instanceof Error ? e.message : String(e), false);
  }
  try {
    const created = await db.transaction((tx) => createProject(tx, { workspaceId: ws, doc, templateId: template.id, templateVersion: template.version, family: template.family, budget: DEFAULT_BUDGET, action: `sizzle from collection “${collection.name}”` }));
    return { projectId: created.project.id, revisionId: created.revision.id, quotes: quotes.map((q) => ({ assetId: q.assetId, sourceName: q.sourceName, clipInSec: q.clipInSec, clipOutSec: q.clipOutSec, cuts: q.report })) };
  } catch (e) {
    if (e instanceof AppError) throw new JobError(e.code, e.message, false);
    throw e;
  }
};
