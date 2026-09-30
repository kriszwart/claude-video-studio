import { and, eq, inArray } from "drizzle-orm";
import {
  AppError,
  applyProjectOperations,
  getDb,
  getProject,
  getClaudeRuntime,
  subscriptionRuntimeAllowed,
  SUBSCRIPTION_NOT_PERSONAL,
  getProviderSecret,
  getRevision,
  getTemplateVersion,
  JobError,
  newId,
  recordClaudeLimit,
  replaceDocument,
  sceneHashes,
  schema,
} from "@vs/db";
import { applyOperations, OperationError, ProjectDocument, type Operation } from "@vs/domain";
import {
  apiBackend,
  CLAUDE_CONFIG,
  estimateClaudeCostMicros,
  ProviderError,
  runEditor,
  runPlanner,
  subscriptionBackend,
  type AssetManifestEntry,
  type ClaudeBackend,
  type StructuredResult,
} from "@vs/providers";
import { fitDuration, TemplateDefinition } from "@vs/templates";
import type { Handler } from "../context";

/**
 * The Claude backend for a workspace, exactly as the owner selected it (PRD §28): the Claude
 * Code subscription runtime by default, the API key only in explicit API mode. A failure in one
 * never falls through to the other.
 */
export async function claudeFor(workspaceId: string, scope: string): Promise<ClaudeBackend> {
  const rt = await getClaudeRuntime(getDb(), workspaceId);
  try {
    if (rt.mode === "off") throw new ProviderError("credentials_missing", "Claude is turned off for this studio, so AI actions are unavailable.", false, "Turn it on in Settings → Claude. Manual editing and rendering keep working.");
    if (rt.mode === "api") return apiBackend((await getProviderSecret(getDb(), workspaceId, "anthropic"))?.secret);
    if (!subscriptionRuntimeAllowed()) throw new ProviderError("credentials_missing", SUBSCRIPTION_NOT_PERSONAL, false, "Switch Settings → Claude to API mode and add an API key.");
    return subscriptionBackend({ scope });
  } catch (e) {
    throw toJobError(e);
  }
}

/** Keep the last usage-window status the runtime reported (shown in Settings; never estimated). */
async function noteLimit(workspaceId: string, e: unknown, usage: StructuredResult["usage"][] = []) {
  const fromUsage = usage.map((u) => u.limit).filter(Boolean).at(-1);
  const details = e instanceof ProviderError && e.code === "usage_limit" ? e.details : null;
  const limit = fromUsage ?? (details ? { status: "rejected" as const, ...(details.rateLimitType ? { rateLimitType: String(details.rateLimitType) } : {}), ...(details.resetsAt ? { resetsAt: String(details.resetsAt) } : {}), at: new Date().toISOString() } : null);
  if (limit) await recordClaudeLimit(getDb(), workspaceId, limit).catch(() => {});
}

export function toJobError(e: unknown): JobError {
  if (e instanceof JobError) return e;
  if (e instanceof ProviderError) return new JobError(e.code, e.message, e.retryable, e.recovery, e.details);
  if (e instanceof AppError) return new JobError(e.code, e.message, false, e.recovery);
  if (e instanceof OperationError) return new JobError(e.code, e.message, false);
  // Unexpected errors: log details server-side, show a safe message to the user.
  console.error("[worker] unexpected error", e instanceof Error ? e.stack : e);
  if (e instanceof Error && /canceled|aborted/i.test(e.message)) return new JobError("canceled", "Canceled.", false);
  return new JobError("internal", "An internal error interrupted this job. It will be retried automatically; if it keeps failing, check the worker log.", true);
}

async function recordUsage(workspaceId: string, projectId: string | null, jobId: string, usage: StructuredResult["usage"][], capability: string) {
  const db = getDb();
  for (const [i, u] of usage.entries()) {
    // Subscription calls draw on the owner's plan limits: no per-call charge is invented for them.
    const subscription = u.runtime === "subscription";
    const micros = subscription ? 0 : estimateClaudeCostMicros(u.model, u.inputTokens, u.outputTokens);
    await db
      .insert(schema.usageLedger)
      .values({
        id: newId("use"),
        workspaceId,
        projectId,
        jobId,
        operationId: `${jobId}:${capability}:${i}`,
        provider: subscription ? "claude_subscription" : "anthropic",
        capability,
        status: micros === null ? "unknown_price" : "settled",
        estimatedMicros: micros,
        actualMicros: micros,
        priceTimestamp: subscription ? null : "list price 2026-09-25",
        priceBasis: subscription
          ? `${u.model}: ${u.inputTokens} in / ${u.outputTokens} out tokens via Claude Code on the owner's Claude plan (counts toward plan usage limits; no API charge)`
          : `${u.model}: ${u.inputTokens} in / ${u.outputTokens} out tokens (list-price estimate)`,
      })
      .onConflictDoNothing();
  }
}

/** Visual media the planner/assistant may use: project inputs plus explicitly attached assets. */
export async function assetManifest(workspaceId: string, doc: ProjectDocument, extraIds: string[] = []): Promise<AssetManifestEntry[]> {
  const ids = new Set(extraIds);
  for (const v of Object.values(doc.brief.inputs)) {
    for (const s of Array.isArray(v) ? v : [v]) if (typeof s === "string" && s.startsWith("ast_")) ids.add(s);
  }
  for (const s of doc.scenes) for (const l of s.layers) if ((l.kind === "image" || l.kind === "video") && l.assetId) ids.add(l.assetId);
  if (doc.brand.logoAssetId) ids.add(doc.brand.logoAssetId);
  if (ids.size === 0) return [];
  const rows = await getDb().query.assets.findMany({ where: and(eq(schema.assets.workspaceId, workspaceId), inArray(schema.assets.id, [...ids]), eq(schema.assets.status, "ready")) });
  return rows.map((a) => {
    const m = a.media as { width?: number; height?: number; durationSec?: number };
    return { id: a.id, kind: a.kind as AssetManifestEntry["kind"], name: a.originalName.slice(0, 80), width: m.width, height: m.height, durationSec: m.durationSec, generated: a.generated };
  });
}

export const planStoryboard: Handler = async (ctx) => {
  const db = getDb();
  const baseRevisionId = String(ctx.job.input.baseRevisionId ?? ctx.job.revisionId);
  const base = await getRevision(db, ctx.job.projectId!, baseRevisionId);
  const doc = ProjectDocument.parse(base.document);
  const { version } = await getTemplateVersion(db, ctx.job.workspaceId, doc.template.templateId, doc.template.version);
  const template = TemplateDefinition.parse(version.definition);
  const client = await claudeFor(ctx.job.workspaceId, ctx.job.projectId ?? ctx.job.id);
  const assets = await assetManifest(ctx.job.workspaceId, doc, (ctx.job.input.assetIds as string[] | undefined) ?? []);
  const target = Number(ctx.job.input.targetDurationSec ?? Math.round(doc.scenes.reduce((a, s) => a + s.durationFrames, 0) / doc.format.fps));

  await ctx.stage("planning with Claude");
  let run;
  try {
    run = await runPlanner(client, { template, doc, assets, targetDurationSec: target, newId }, { signal: ctx.signal });
  } catch (e) {
    await noteLimit(ctx.job.workspaceId, e);
    throw toJobError(e);
  }
  await noteLimit(ctx.job.workspaceId, null, run.usage);
  await recordUsage(ctx.job.workspaceId, ctx.job.projectId, ctx.job.id, run.usage, "plan");

  await ctx.stage("validating storyboard");
  const replaced = applyOperations(doc, [{ op: "replaceScenes", scenes: run.scenes }], "bulk").doc;
  const next = fitDuration(replaced, target);
  try {
    const revision = await db.transaction((tx) => replaceDocument(tx, { projectId: ctx.job.projectId!, workspaceId: ctx.job.workspaceId, baseRevisionId, doc: next, author: "planner", action: `storyboard planned (${run.attempts} attempt${run.attempts > 1 ? "s" : ""})` }));
    return { revisionId: revision.id, rationale: run.plan.rationale, omitted: run.plan.omitted, warnings: run.plan.warnings, attempts: run.attempts, repairs: run.repairs, model: run.usage.at(-1)?.model ?? CLAUDE_CONFIG.model, runtime: client.kind };
  } catch (e) {
    if (e instanceof AppError && e.status === 409) {
      // Never overwrite newer user edits with a stale plan.
      return { status: "stale", message: "The project changed while planning. The plan was not applied; run planning again to use the latest edits.", rationale: run.plan.rationale };
    }
    throw toJobError(e);
  }
};

const GLOBAL_OPS = new Set<Operation["op"]>(["setFormat", "applyBrand", "applyCreativeProfile", "moveScene", "deleteScene", "duplicateScene", "addScene", "replaceScenes", "setTitle", "updateBrief", "setCaptions", "setCaptionCues", "setMarkers", "setMusicLock", "setProgram"]);

/**
 * A stale assistant response may be rebased only when every scene it touches is unchanged
 * between its base and the current revision and it contains no document-wide operations.
 */
export function canRebase(ops: Operation[], baseDoc: ProjectDocument, currentDoc: ProjectDocument): { ok: boolean; reason?: string } {
  const b = sceneHashes(baseDoc);
  const c = sceneHashes(currentDoc);
  for (const op of ops) {
    if (GLOBAL_OPS.has(op.op)) return { ok: false, reason: `"${op.op}" affects the whole project` };
    if ("sceneId" in op) {
      if (b[op.sceneId] !== c[op.sceneId]) return { ok: false, reason: "a scene it edits was changed in the meantime" };
    }
    if ("trackId" in op) {
      const bt = baseDoc.audio.find((t) => t.id === op.trackId);
      const ct = currentDoc.audio.find((t) => t.id === op.trackId);
      if (JSON.stringify(bt) !== JSON.stringify(ct)) return { ok: false, reason: "an audio track it edits was changed in the meantime" };
    }
  }
  return { ok: true };
}

export const assistantEdit: Handler = async (ctx) => {
  const db = getDb();
  const baseRevisionId = String(ctx.job.input.baseRevisionId ?? ctx.job.revisionId);
  const base = await getRevision(db, ctx.job.projectId!, baseRevisionId);
  const doc = ProjectDocument.parse(base.document);
  const client = await claudeFor(ctx.job.workspaceId, ctx.job.projectId ?? ctx.job.id);
  const kits = await db.query.brandKits.findMany({ where: and(eq(schema.brandKits.workspaceId, ctx.job.workspaceId), eq(schema.brandKits.archived, false)) });
  const assets = await assetManifest(ctx.job.workspaceId, doc, (ctx.job.input.assetIds as string[] | undefined) ?? []);

  await ctx.stage("asking Claude");
  let res;
  try {
    res = await runEditor(
      client,
      {
        doc,
        request: String(ctx.job.input.request ?? "").slice(0, 2000),
        selectedSceneIds: (ctx.job.input.selectedSceneIds as string[] | undefined) ?? [],
        assets,
        brandKits: kits.map((k) => ({ id: k.id, name: k.name, snapshot: { ...(k.data as ProjectDocument["brand"]), brandKitId: k.id, brandKitVersion: k.version } })),
        newId,
      },
      ctx.signal,
    );
  } catch (e) {
    await noteLimit(ctx.job.workspaceId, e);
    throw toJobError(e);
  }
  await noteLimit(ctx.job.workspaceId, null, [res.usage]);
  await recordUsage(ctx.job.workspaceId, ctx.job.projectId, ctx.job.id, [res.usage], "assistant");
  if (res.output.clarificationQuestion) return { status: "clarify", question: res.output.clarificationQuestion, explanation: res.output.explanation };
  if (res.ops.length === 0) return { status: "no_change", explanation: res.output.explanation };

  await ctx.stage("applying edits");
  const attempt = async (baseId: string) =>
    db.transaction((tx) => applyProjectOperations(tx, { projectId: ctx.job.projectId!, workspaceId: ctx.job.workspaceId, baseRevisionId: baseId, ops: res.ops, actor: "assistant", action: `assistant: ${String(ctx.job.input.request).slice(0, 60)}` }));
  try {
    const r = await attempt(baseRevisionId);
    return { status: "applied", revisionId: r.revision.id, changedSceneIds: r.changedSceneIds, explanation: res.output.explanation, operations: res.ops };
  } catch (e) {
    if (e instanceof AppError && e.status === 409 && e.code === "stale_revision") {
      const { revision, doc: current } = await getProject(db, ctx.job.projectId!, ctx.job.workspaceId);
      const rb = canRebase(res.ops, doc, current);
      if (!rb.ok) {
        return { status: "rejected_stale", explanation: res.output.explanation, message: `Not applied: the project changed while the assistant was working and ${rb.reason}. Ask again to use your latest edits.` };
      }
      try {
        const r = await attempt(revision.id);
        return { status: "applied", rebased: true, revisionId: r.revision.id, changedSceneIds: r.changedSceneIds, explanation: res.output.explanation, operations: res.ops };
      } catch (e2) {
        throw toJobError(e2);
      }
    }
    if (e instanceof AppError && (e.code === "locked" || e.code === "approved_claim")) {
      return { status: "refused", explanation: res.output.explanation, message: e.message };
    }
    throw toJobError(e);
  }
};
