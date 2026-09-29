import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import {
  AppError,
  applyProjectOperations,
  getDb,
  getProject,
  getProviderSecret,
  getProviderSettings,
  JobError,
  newId,
  releaseSpend,
  reserveSpend,
  schema,
  setWaitingProvider,
  settleSpend,
  webhookToken,
} from "@vs/db";
import type { Operation, ProjectDocument, Scene } from "@vs/domain";
import { estimateFor, FalQueue, FalSettings, falOutputFiles, MediaProviderError } from "@vs/providers";
import { FFMPEG, runOk } from "@vs/rendering";
import { registerFile, resolveAssets, type Handler, type JobContext } from "../context";
import { safeFetch, UnsafeUrlError } from "../net/safeFetch";

type GenRow = typeof schema.generationRequests.$inferSelect;

/** Test seam (non-production only): accept provider output URLs served by a local fixture. */
function outputFetchOptions() {
  const trusted = process.env.NODE_ENV !== "production" ? (process.env.VS_TEST_TRUSTED_OUTPUT ?? "").split(",").filter(Boolean) : [];
  return trusted.length ? { trustAddresses: trusted.map((t) => t.split(":")[0]!), allowPorts: trusted.map((t) => Number(t.split(":")[1])) } : {};
}

async function applyWithRetry(ctx: JobContext, ops: (doc: ProjectDocument) => Operation[], action: string) {
  const db = getDb();
  for (let attempt = 0; attempt < 4; attempt++) {
    const { revision, doc } = await getProject(db, ctx.job.projectId!, ctx.job.workspaceId);
    const list = ops(doc);
    if (!list.length) return;
    try {
      await db.transaction((tx) => applyProjectOperations(tx, { projectId: ctx.job.projectId!, workspaceId: ctx.job.workspaceId, baseRevisionId: revision.id, ops: list, actor: "system", author: "system", action }));
      return;
    } catch (e) {
      if (e instanceof AppError && e.status === 409) continue;
      throw e;
    }
  }
}

async function updateGen(id: string, patch: Partial<GenRow>) {
  await getDb().update(schema.generationRequests).set({ ...patch, updatedAt: sql`now()` }).where(eq(schema.generationRequests.id, id));
}

/** Provider input for a shot: prompt + continuity + character notes, optional reference image. */
async function buildInput(ctx: JobContext, doc: ProjectDocument, scene: Scene, maxDurationSec?: number): Promise<Record<string, unknown>> {
  const shot = scene.shot!;
  const chars = doc.characters.filter((c) => shot.characterIds.includes(c.id));
  const prompt = [shot.prompt, shot.continuity && `Continuity: ${shot.continuity}`, ...chars.map((c) => `${c.name}: ${c.notes || `${c.species} character, body ${c.palette.body}, accent ${c.palette.accent}`}`)].filter(Boolean).join("\n");
  const input: Record<string, unknown> = { prompt: prompt.slice(0, 2000), aspect_ratio: doc.format.aspect };
  if (shot.kind === "video") input.duration = Math.max(1, Math.min(maxDurationSec ?? 5, Math.round(scene.durationFrames / doc.format.fps)));
  const refId = shot.referenceAssetIds[0] ?? chars.flatMap((c) => c.referenceAssetIds)[0];
  if (refId) {
    // References are sent inline (downscaled) so no internal URL is ever exposed to the provider.
    const ref = (await resolveAssets(ctx.job.workspaceId, [refId])).get(refId)!;
    const small = join(ctx.workDir, "reference.jpg");
    await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", ref.path, "-vf", "scale='min(1024,iw)':-2", "-frames:v", "1", "-q:v", "3", small], { timeoutMs: 60_000 });
    input.image_url = `data:image/jpeg;base64,${(await readFile(small)).toString("base64")}`;
  }
  return input;
}

/**
 * Generate one shot (T7/P6) through fal's queue (FR-12, §12):
 *  budget check + ledger reservation → persisted request id → webhook or polling →
 *  safe download → normalisation → asset with provenance → settle → candidate on the shot.
 * A retry never resubmits a request whose id is known; an unknown submission outcome
 * becomes "uncertain" and needs the owner's decision.
 */
export const generateMedia: Handler = async (ctx) => {
  const db = getDb();
  const sceneId = String(ctx.job.input.sceneId);
  const { doc } = await getProject(db, ctx.job.projectId!, ctx.job.workspaceId);
  const scene = doc.scenes.find((s) => s.id === sceneId);
  if (!scene?.shot) throw new JobError("invalid_input", "That scene is not a footage shot.", false);
  const shot = scene.shot;
  const variant = Number(ctx.job.input.variant ?? shot.variant);
  const operationId = `${ctx.job.projectId}:${sceneId}:v${variant}`;
  const settings = FalSettings.safeParse(await getProviderSettings(db, ctx.job.workspaceId, "fal"));
  const model = settings.success ? settings.data[shot.kind] : undefined;
  if (!model) throw new JobError("provider_not_configured", `No fal ${shot.kind} model is configured.`, false, `Choose a ${shot.kind} model endpoint (and its price) in Settings → Providers, or supply your own footage for this shot.`);
  const secret = await getProviderSecret(db, ctx.job.workspaceId, "fal");
  if (!secret) throw new JobError("credentials_missing", "fal is not configured.", false, "Add a fal API key in Settings, or supply your own footage for this shot.");
  const fal = new FalQueue(secret.secret);

  let g = await db.query.generationRequests.findFirst({ where: and(eq(schema.generationRequests.workspaceId, ctx.job.workspaceId), eq(schema.generationRequests.operationId, operationId)) });
  if (g?.state === "succeeded" && g.assetId) return attach(ctx, sceneId, g, g.assetId);
  if (g?.state === "uncertain" || g?.state === "submitting") {
    if (g.state === "submitting") await updateGen(g.id, { state: "uncertain", error: { message: "The worker stopped after sending the request but before fal confirmed it." } });
    throw new JobError("provider_uncertain", "It is unknown whether fal accepted this request, so it was not sent again (it may have been billed).", false, "Check your fal dashboard. To try again anyway, use Regenerate, which creates a new, separately billed request.");
  }
  if (g?.state === "canceled") throw new JobError("canceled", "This request was canceled.", false, "Use Regenerate to create a new request.");
  if (g?.state === "failed" && !(g.error as { retryable?: boolean } | null)?.retryable) throw new JobError("provider_failed", String((g.error as { message?: string })?.message ?? "Generation failed."), false, "Adjust the prompt and use Regenerate.");

  if (!g || g.state === "failed") {
    // 1) Authorise spend and record intent before anything is sent (A09).
    const estimate = estimateFor(model);
    const genId = g?.id ?? newId("gen");
    const reserved = await db.transaction(async (tx) => {
      const r = await reserveSpend(tx, { workspaceId: ctx.job.workspaceId, projectId: ctx.job.projectId!, jobId: ctx.job.id, operationId, provider: "fal", capability: `${shot.kind}-generation`, estimate });
      if (!r.decision.allowed) return r;
      const values = { workspaceId: ctx.job.workspaceId, projectId: ctx.job.projectId, jobId: ctx.job.id, operationId, provider: "fal", endpoint: model.endpoint, capability: shot.kind, state: "submitting" as const, input: {}, requestId: null, error: null };
      if (g) await tx.update(schema.generationRequests).set({ ...values, updatedAt: sql`now()` }).where(eq(schema.generationRequests.id, genId));
      else await tx.insert(schema.generationRequests).values({ id: genId, ...values });
      return r;
    });
    if (!reserved.decision.allowed) {
      await applyWithRetry(ctx, () => [{ op: "setShotStatus", sceneId, status: "failed", error: reserved.decision.allowed ? undefined : reserved.decision.message }], "shot blocked by budget");
      throw new JobError(reserved.decision.code, reserved.decision.message, false, reserved.decision.code === "unknown_price_unauthorized" ? "Authorise a number of unknown-price requests in the project budget, or enter the model's price in Settings." : "Raise the project budget or supply your own footage.");
    }
    await ctx.stage("preparing request");
    const input = await buildInput(ctx, doc, scene, model.maxDurationSec);
    await updateGen(genId, { input: { ...input, image_url: input.image_url ? "(inline reference image)" : undefined } });
    const base = process.env.PUBLIC_BASE_URL;
    const webhookUrl = base ? `${base.replace(/\/$/, "")}/api/providers/fal/webhook?g=${genId}&t=${webhookToken("fal", genId)}` : undefined;
    // 2) Submit and persist the provider request id immediately.
    await ctx.stage("submitting to fal");
    try {
      const { requestId } = await fal.submit(model.endpoint, input, { webhookUrl, signal: ctx.signal });
      await updateGen(genId, { requestId, state: "submitted" });
      await setWaitingProvider(ctx.job.id, ctx.workerId, requestId);
    } catch (e) {
      const err = e instanceof MediaProviderError ? e : new MediaProviderError("network_uncertain", String(e), false);
      if (err.code === "network_uncertain") {
        await updateGen(genId, { state: "uncertain", error: { message: err.message } });
        throw new JobError("provider_uncertain", "fal did not confirm the request; it was not resent (it may have been billed).", false, "Check your fal dashboard, then use Regenerate if needed.");
      }
      // A definite rejection: nothing was queued, so nothing is billed.
      await updateGen(genId, { state: "failed", error: { message: err.message, retryable: err.retryable, code: err.code } });
      await releaseSpend(db, ctx.job.workspaceId, operationId);
      if (!err.retryable) await applyWithRetry(ctx, () => [{ op: "setShotStatus", sceneId, status: "failed", error: err.message.slice(0, 300) }], "shot generation failed");
      throw new JobError(err.code, err.message, err.retryable, err.code === "credentials_invalid" ? "Check the fal key in Settings." : undefined);
    }
    await applyWithRetry(ctx, (d) => (d.scenes.find((s) => s.id === sceneId)?.shot?.status === "accepted" ? [] : [{ op: "setShotStatus", sceneId, status: "generating", variant }]), "shot generating");
    g = await db.query.generationRequests.findFirst({ where: eq(schema.generationRequests.id, genId) });
  } else {
    await ctx.stage("reconciling with fal");
    if (g.requestId) await setWaitingProvider(ctx.job.id, ctx.workerId, g.requestId);
  }

  // 3) Wait: a verified webhook updates the row; polling is the fallback.
  const deadline = Date.now() + Number(process.env.FAL_WAIT_MAX_SEC ?? 1800) * 1000;
  let delay = 2000;
  let payload: Record<string, unknown> | null = null;
  for (;;) {
    if (ctx.signal.aborted) return cancelRequest(ctx, fal, g!, operationId, sceneId);
    const cur = (await db.query.generationRequests.findFirst({ where: eq(schema.generationRequests.id, g!.id) }))!;
    if (cur.state === "succeeded" && cur.output) {
      payload = cur.output as Record<string, unknown>;
      break;
    }
    if (cur.state === "failed") return failGenerated(ctx, cur, operationId, sceneId, String((cur.error as { message?: string })?.message ?? "fal reported an error."));
    await ctx.stage("waiting for fal");
    try {
      const st = await fal.status(model.endpoint, cur.requestId!, ctx.signal);
      if (st.state === "completed") {
        payload = await fal.result(model.endpoint, cur.requestId!, ctx.signal);
        await updateGen(cur.id, { state: "succeeded", output: payload });
        break;
      }
      if (st.state === "failed") {
        await updateGen(cur.id, { state: "failed", error: { message: String(st.raw.error ?? "fal reported an error.") } });
        return failGenerated(ctx, cur, operationId, sceneId, String(st.raw.error ?? "fal reported an error."));
      }
    } catch (e) {
      if (!(e instanceof MediaProviderError) || !e.retryable) {
        if (e instanceof MediaProviderError && e.code === "credentials_invalid") throw new JobError(e.code, e.message, false, "Check the fal key in Settings.");
        // Status endpoint trouble: keep polling until the deadline; the request id is safe.
      }
    }
    if (Date.now() > deadline) throw new JobError("provider_timeout", "fal has not finished yet. The request is kept and will be checked again.", true);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.6, 20_000);
  }

  // 4) Download (SSRF-guarded), normalise, register with provenance, settle.
  const file = falOutputFiles((payload as { payload?: unknown }).payload ?? payload)[0];
  if (!file) return failGenerated(ctx, g!, operationId, sceneId, "fal finished but returned no media file.");
  await ctx.stage("downloading result");
  let bytes: Buffer;
  try {
    bytes = (await safeFetch(file.url, { maxBytes: 500 * 1024 * 1024, allowedTypes: /^(image|video)\//, signal: ctx.signal, timeoutMs: 120_000, ...outputFetchOptions() })).body;
  } catch (e) {
    throw new JobError(e instanceof UnsafeUrlError ? e.code : "download_failed", `The generated file could not be downloaded: ${(e as Error).message}`, !(e instanceof UnsafeUrlError) || e.code === "timeout");
  }
  const raw = join(ctx.workDir, shot.kind === "video" ? "gen.bin" : "gen-image");
  await writeFile(raw, bytes);
  let out = raw;
  if (shot.kind === "video") {
    await ctx.stage("normalising footage");
    out = join(ctx.workDir, "shot.mp4");
    await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", raw, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-an", "-movflags", "+faststart", out], { timeoutMs: 600_000, signal: ctx.signal });
  } else {
    out = join(ctx.workDir, "shot.png");
    await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", raw, "-frames:v", "1", out], { timeoutMs: 60_000 });
  }
  const asset = await registerFile(ctx.job.workspaceId, out, {
    kind: shot.kind,
    originalName: `generated-${scene.purpose.replace(/\W+/g, "-").toLowerCase()}-v${variant}.${shot.kind === "video" ? "mp4" : "png"}`,
    generated: true,
    provenance: { source: "generated", provider: "fal", endpoint: model.endpoint, requestId: g!.requestId, operationId, prompt: shot.prompt, referenceAssetIds: shot.referenceAssetIds, projectId: ctx.job.projectId, sceneId, generatedAt: new Date().toISOString(), outputUrl: file.url },
  });
  await settleSpend(db, ctx.job.workspaceId, operationId, model.priceMicros);
  await updateGen(g!.id, { assetId: asset.id });
  return attach(ctx, sceneId, { ...g!, assetId: asset.id }, asset.id);
};

async function attach(ctx: JobContext, sceneId: string, g: GenRow, assetId: string) {
  await applyWithRetry(ctx, () => [{ op: "addShotCandidate", sceneId, candidate: { assetId, generationId: g.id, provider: "fal", createdAt: new Date().toISOString() }, autoAccept: true }], "generated shot ready");
  return { sceneId, assetId, generationId: g.id, requestId: g.requestId, operationId: g.operationId };
}

async function failGenerated(ctx: JobContext, g: GenRow, operationId: string, sceneId: string, message: string): Promise<never> {
  // fal failures after queueing may still be billed by fal; keep the reservation settled at
  // the estimate unless the owner reconciles it, and say so.
  await settleSpend(getDb(), ctx.job.workspaceId, operationId, null);
  await applyWithRetry(ctx, () => [{ op: "setShotStatus", sceneId, status: "failed", error: message.slice(0, 300) }], "shot generation failed");
  throw new JobError("provider_failed", message, false, "Adjust the prompt and use Regenerate, or supply your own footage. Failed provider requests may still be billed by fal.");
}

async function cancelRequest(ctx: JobContext, fal: FalQueue, g: GenRow, operationId: string, sceneId: string): Promise<never> {
  await fal.cancel(g.endpoint, g.requestId!).catch(() => undefined);
  await updateGen(g.id, { state: "canceled" });
  await getDb()
    .update(schema.usageLedger)
    .set({ priceBasis: sql`coalesce(${schema.usageLedger.priceBasis}, '') || ' · canceled after submission; fal may still bill work already started'` })
    .where(and(eq(schema.usageLedger.workspaceId, ctx.job.workspaceId), eq(schema.usageLedger.operationId, operationId)));
  await applyWithRetry(ctx, (d) => (d.scenes.find((s) => s.id === sceneId)?.shot?.status === "accepted" ? [] : [{ op: "setShotStatus", sceneId, status: "pending" }]), "shot generation canceled");
  throw new JobError("canceled", "Canceled. fal may still bill work that had already started.", false);
}

/**
 * A result that arrives after cancellation is kept for recovery (added to the library as a
 * candidate) but never restarts the canceled pipeline or changes the timeline.
 */
export const recoverGeneration: Handler = async (ctx) => {
  const db = getDb();
  const g = await db.query.generationRequests.findFirst({ where: and(eq(schema.generationRequests.id, String(ctx.job.input.generationId)), eq(schema.generationRequests.workspaceId, ctx.job.workspaceId)) });
  if (!g?.output || g.assetId) return { skipped: true };
  const file = falOutputFiles((g.output as { payload?: unknown }).payload ?? g.output)[0];
  if (!file) return { skipped: true, reason: "no media in late result" };
  const r = await safeFetch(file.url, { maxBytes: 500 * 1024 * 1024, allowedTypes: /^(image|video)\//, timeoutMs: 120_000, ...outputFetchOptions() });
  const p = join(ctx.workDir, g.capability === "video" ? "late.mp4" : "late.png");
  await writeFile(p, r.body);
  const asset = await registerFile(ctx.job.workspaceId, p, { kind: g.capability, originalName: `late-result-${g.id}.${g.capability === "video" ? "mp4" : "png"}`, generated: true, provenance: { source: "generated", provider: "fal", requestId: g.requestId, operationId: g.operationId, note: "arrived after cancellation; kept for recovery, not placed on the timeline" } });
  await db.update(schema.generationRequests).set({ assetId: asset.id, updatedAt: sql`now()` }).where(eq(schema.generationRequests.id, g.id));
  await settleSpend(db, ctx.job.workspaceId, g.operationId, null);
  return { assetId: asset.id, recovered: true };
};
