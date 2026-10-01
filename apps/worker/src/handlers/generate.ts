import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import {
  AppError,
  applyProjectOperations,
  enqueueJob,
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
  subscriptionRuntimeAllowed,
  webhookToken,
} from "@vs/db";
import type { Operation, ProjectDocument, Scene, ShotReview } from "@vs/domain";
import { CodexError, CodexImages, CodexSettings, pickImageProvider, decodeDataUrl, estimateFor, FalQueue, FalSettings, falOutputFiles, MediaProviderError, OpenRouterImages, openRouterEstimate, OpenRouterSettings } from "@vs/providers";
import { FFMPEG, productFidelity, runOk } from "@vs/rendering";
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
async function buildInput(ctx: JobContext, doc: ProjectDocument, scene: Scene, kind: "image" | "video", maxDurationSec?: number): Promise<Record<string, unknown>> {
  const shot = scene.shot!;
  const chars = doc.characters.filter((c) => shot.characterIds.includes(c.id));
  const prompt = [shot.prompt, shot.continuity && `Continuity: ${shot.continuity}`, ...chars.map((c) => `${c.name}: ${c.notes || `${c.species} character, body ${c.palette.body}, accent ${c.palette.accent}`}`)].filter(Boolean).join("\n");
  const input: Record<string, unknown> = { prompt: prompt.slice(0, 2000), aspect_ratio: doc.format.aspect };
  if (kind === "video") input.duration = Math.max(1, Math.min(maxDurationSec ?? 5, Math.round(scene.durationFrames / doc.format.fps)));
  // Image-to-video: an approved keyframe is the first frame; otherwise the first reference.
  const refId = (kind === "video" ? shot.keyframeAssetId : undefined) ?? shot.referenceAssetIds[0] ?? chars.flatMap((c) => c.referenceAssetIds)[0];
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
  if (doc.acquisitionPolicy !== "generated-allowed") throw new JobError("generation_not_allowed", "This project's asset policy doesn't allow generated media.", false, "Allow generated media in the Shots panel, or supply your own footage.");
  const shot = scene.shot;
  // Keyframe mode: an image of the intended first frame of a video shot (animatic first).
  const keyframe = ctx.job.input.mode === "keyframe";
  if (keyframe && shot.kind !== "video") throw new JobError("invalid_input", "Keyframes are for video shots.", false);
  const kind: "image" | "video" = keyframe ? "image" : shot.kind;
  // The animatic gate: once keyframes exist, video waits for the owner's approval.
  if (kind === "video" && doc.animatic && doc.animatic.status !== "approved") throw new JobError("animatic_not_approved", "Approve the animatic before generating video.", false, "Render the animatic from the keyframes, review it, then approve it in the Shots panel.");
  const variant = Number(ctx.job.input.variant ?? shot.variant);
  const operationId = `${ctx.job.projectId}:${sceneId}:${keyframe ? "kf" : "v"}${variant}`;
  const settings = FalSettings.safeParse(await getProviderSettings(db, ctx.job.workspaceId, "fal"));
  const model = settings.success ? settings.data[kind] : undefined;
  // Image shots and keyframes may use OpenRouter (one key, many image models) when it is configured.
  if (kind === "image") {
    const or = OpenRouterSettings.safeParse(await getProviderSettings(db, ctx.job.workspaceId, "openrouter"));
    const orKey = await getProviderSecret(db, ctx.job.workspaceId, "openrouter");
    const orReady = or.success && !!or.data.image && !!orKey;
    const cx = CodexSettings.safeParse(await getProviderSettings(db, ctx.job.workspaceId, "codex"));
    const via = pickImageProvider({ codex: cx.success ? cx.data : null, codexAllowed: subscriptionRuntimeAllowed(), openRouterReady: orReady, openRouterPreferred: or.success && or.data.preferForImages, falImage: !!model });
    if (via === "codex") return generateViaCodex(ctx, doc, scene, variant, operationId, keyframe);
    if (via === "openrouter") return generateViaOpenRouter(ctx, doc, scene, variant, operationId, or.data!, orKey!.secret, keyframe);
  }
  if (!model) throw new JobError("provider_not_configured", `No ${kind} model is configured.`, false, `Choose a ${kind} model (and its price) in Settings → Providers, or supply your own footage for this shot.`);
  const secret = await getProviderSecret(db, ctx.job.workspaceId, "fal");
  if (!secret) throw new JobError("credentials_missing", "fal is not configured.", false, "Add a fal API key in Settings, or supply your own footage for this shot.");
  const fal = new FalQueue(secret.secret);

  let g = await db.query.generationRequests.findFirst({ where: and(eq(schema.generationRequests.workspaceId, ctx.job.workspaceId), eq(schema.generationRequests.operationId, operationId)) });
  if (g?.state === "succeeded" && g.assetId) return attach(ctx, sceneId, g, g.assetId, undefined, keyframe);
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
      const r = await reserveSpend(tx, { workspaceId: ctx.job.workspaceId, projectId: ctx.job.projectId!, jobId: ctx.job.id, operationId, provider: "fal", capability: `${kind}-generation`, estimate });
      if (!r.decision.allowed) return r;
      const values = { workspaceId: ctx.job.workspaceId, projectId: ctx.job.projectId, jobId: ctx.job.id, operationId, provider: "fal", endpoint: model.endpoint, capability: kind, state: "submitting" as const, input: {}, requestId: null, error: null };
      if (g) await tx.update(schema.generationRequests).set({ ...values, updatedAt: sql`now()` }).where(eq(schema.generationRequests.id, genId));
      else await tx.insert(schema.generationRequests).values({ id: genId, ...values });
      return r;
    });
    if (!reserved.decision.allowed) {
      if (!keyframe) await applyWithRetry(ctx, () => [{ op: "setShotStatus", sceneId, status: "failed", error: reserved.decision.allowed ? undefined : reserved.decision.message }], "shot blocked by budget");
      throw new JobError(reserved.decision.code, reserved.decision.message, false, reserved.decision.code === "unknown_price_unauthorized" ? "Authorise a number of unknown-price requests in the project budget, or enter the model's price in Settings." : "Raise the project budget or supply your own footage.");
    }
    await ctx.stage("preparing request");
    const input = await buildInput(ctx, doc, scene, kind, model.maxDurationSec);
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
      if (!err.retryable && !keyframe) await applyWithRetry(ctx, () => [{ op: "setShotStatus", sceneId, status: "failed", error: err.message.slice(0, 300) }], "shot generation failed");
      throw new JobError(err.code, err.message, err.retryable, err.code === "credentials_invalid" ? "Check the fal key in Settings." : undefined);
    }
    if (!keyframe) await applyWithRetry(ctx, (d) => (d.scenes.find((s) => s.id === sceneId)?.shot?.status === "accepted" ? [] : [{ op: "setShotStatus", sceneId, status: "generating", variant }]), "shot generating");
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
    if (cur.state === "failed") return failGenerated(ctx, cur, operationId, sceneId, String((cur.error as { message?: string })?.message ?? "fal reported an error."), keyframe);
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
        return failGenerated(ctx, cur, operationId, sceneId, String(st.raw.error ?? "fal reported an error."), keyframe);
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
  if (!file) return failGenerated(ctx, g!, operationId, sceneId, "fal finished but returned no media file.", keyframe);
  await ctx.stage("downloading result");
  let bytes: Buffer;
  try {
    bytes = (await safeFetch(file.url, { maxBytes: 500 * 1024 * 1024, allowedTypes: /^(image|video)\//, signal: ctx.signal, timeoutMs: 120_000, ...outputFetchOptions() })).body;
  } catch (e) {
    throw new JobError(e instanceof UnsafeUrlError ? e.code : "download_failed", `The generated file could not be downloaded: ${(e as Error).message}`, !(e instanceof UnsafeUrlError) || e.code === "timeout");
  }
  const raw = join(ctx.workDir, kind === "video" ? "gen.bin" : "gen-image");
  await writeFile(raw, bytes);
  let out = raw;
  if (kind === "video") {
    await ctx.stage("normalising footage");
    out = join(ctx.workDir, "shot.mp4");
    await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", raw, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-an", "-movflags", "+faststart", out], { timeoutMs: 600_000, signal: ctx.signal });
  } else {
    out = join(ctx.workDir, "shot.png");
    await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", raw, "-frames:v", "1", out], { timeoutMs: 60_000 });
  }
  const asset = await registerFile(ctx.job.workspaceId, out, {
    kind,
    originalName: `${keyframe ? "keyframe" : "generated"}-${scene.purpose.replace(/\W+/g, "-").toLowerCase()}-v${variant}.${kind === "video" ? "mp4" : "png"}`,
    generated: true,
    provenance: { source: "generated", provider: "fal", endpoint: model.endpoint, requestId: g!.requestId, operationId, prompt: shot.prompt, referenceAssetIds: shot.referenceAssetIds, projectId: ctx.job.projectId, sceneId, generatedAt: new Date().toISOString(), outputUrl: file.url },
  });
  await settleSpend(db, ctx.job.workspaceId, operationId, model.priceMicros);
  await updateGen(g!.id, { assetId: asset.id });
  // Product/character fidelity (A23): measured colour comparison with the approved reference.
  let review: ShotReview | undefined;
  const refId = shot.referenceAssetIds[0];
  if (refId) {
    await ctx.stage("checking fidelity");
    const ref = (await resolveAssets(ctx.job.workspaceId, [refId])).get(refId);
    if (ref) {
      const dur = kind === "video" ? Number((asset.media as { durationSec?: number }).durationSec ?? 0) || undefined : undefined;
      const f = await productFidelity(out, ref.path, dur);
      review = { referenceAssetId: refId, ...f, decision: "pending" };
    }
  }
  return attach(ctx, sceneId, { ...g!, assetId: asset.id }, asset.id, review, keyframe);
};

async function attach(ctx: JobContext, sceneId: string, g: GenRow, assetId: string, review?: ShotReview, keyframe = false) {
  if (keyframe) {
    await applyWithRetry(ctx, () => [{ op: "setShotKeyframe", sceneId, assetId }], "keyframe generated");
    return { sceneId, assetId, keyframe: true, generationId: g.id, operationId: g.operationId, fidelity: review ?? null };
  }
  await applyWithRetry(ctx, () => [{ op: "addShotCandidate", sceneId, candidate: { assetId, generationId: g.id, provider: g.provider, createdAt: new Date().toISOString(), ...(review ? { review } : {}) }, autoAccept: true }], review?.flagged ? "generated shot needs fidelity review" : "generated shot ready");
  // Owner opt-in: queue Claude's product check for this take (once per take).
  const { doc } = await getProject(getDb(), ctx.job.projectId!, ctx.job.workspaceId);
  if (doc.autoProductCheck && doc.scenes.find((s) => s.id === sceneId)?.shot?.referenceAssetIds.length) {
    await enqueueJob(getDb(), { workspaceId: ctx.job.workspaceId, projectId: ctx.job.projectId, revisionId: null, type: "check_fidelity", input: { assetId, auto: true }, idempotencyKey: `auto-product-check:${ctx.job.projectId}:${sceneId}:${assetId}` });
  }
  return { sceneId, assetId, generationId: g.id, requestId: g.requestId, operationId: g.operationId, fidelity: review ?? null };
}

/** Reference images for a shot (its own, then its characters'), downscaled and inlined. */
async function referenceImages(ctx: JobContext, doc: ProjectDocument, scene: Scene, max = 3) {
  const shot = scene.shot!;
  const chars = doc.characters.filter((c) => shot.characterIds.includes(c.id));
  const ids = [...new Set([...shot.referenceAssetIds, ...chars.flatMap((c) => c.referenceAssetIds)])].slice(0, max);
  const files = await resolveAssets(ctx.job.workspaceId, ids);
  const out: { id: string; mediaType: "image/jpeg"; data: string }[] = [];
  for (const [i, id] of ids.entries()) {
    const small = join(ctx.workDir, `ref-${i}.jpg`);
    await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", files.get(id)!.path, "-vf", "scale='min(1024,iw)':-2", "-frames:v", "1", "-q:v", "3", small], { timeoutMs: 60_000 });
    out.push({ id, mediaType: "image/jpeg", data: (await readFile(small)).toString("base64") });
  }
  return out;
}

/**
 * Image shot through OpenRouter: a single synchronous call inside the same guarantees as fal —
 * budget reserved and intent recorded before sending; an unanswered call becomes "uncertain" and
 * is never resent; a definite rejection releases the reservation; the ledger settles at the cost
 * OpenRouter reports when it reports one.
 */
async function generateViaOpenRouter(ctx: JobContext, doc: ProjectDocument, scene: Scene, variant: number, operationId: string, settings: OpenRouterSettings, key: string, keyframe = false) {
  const db = getDb();
  const sceneId = scene.id;
  const shot = scene.shot!;
  const model = settings.image!;
  let g = await db.query.generationRequests.findFirst({ where: and(eq(schema.generationRequests.workspaceId, ctx.job.workspaceId), eq(schema.generationRequests.operationId, operationId)) });
  if (g?.state === "succeeded" && g.assetId) return attach(ctx, sceneId, g, g.assetId, undefined, keyframe);
  if (g?.state === "uncertain" || g?.state === "submitting") {
    if (g.state === "submitting") await updateGen(g.id, { state: "uncertain", error: { message: "The worker stopped while OpenRouter was generating." } });
    throw new JobError("provider_uncertain", "It is unknown whether OpenRouter completed this request, so it was not sent again (it may have been billed).", false, "Check your OpenRouter activity page. To try again anyway, use Regenerate, which creates a new, separately billed request.");
  }
  if (g?.state === "failed" && !(g.error as { retryable?: boolean } | null)?.retryable) throw new JobError("provider_failed", String((g.error as { message?: string })?.message ?? "Generation failed."), false, "Adjust the prompt and use Regenerate.");

  const genId = g?.id ?? newId("gen");
  const reserved = await db.transaction(async (tx) => {
    const r = await reserveSpend(tx, { workspaceId: ctx.job.workspaceId, projectId: ctx.job.projectId!, jobId: ctx.job.id, operationId, provider: "openrouter", capability: "image-generation", estimate: openRouterEstimate(settings) });
    if (!r.decision.allowed) return r;
    const values = { workspaceId: ctx.job.workspaceId, projectId: ctx.job.projectId, jobId: ctx.job.id, operationId, provider: "openrouter", endpoint: model.model, capability: "image" as const, state: "submitting" as const, input: {}, requestId: null, error: null };
    if (g) await tx.update(schema.generationRequests).set({ ...values, updatedAt: sql`now()` }).where(eq(schema.generationRequests.id, genId));
    else await tx.insert(schema.generationRequests).values({ id: genId, ...values });
    return r;
  });
  if (!reserved.decision.allowed) {
    if (!keyframe) await applyWithRetry(ctx, () => [{ op: "setShotStatus", sceneId, status: "failed", error: reserved.decision.allowed ? undefined : reserved.decision.message }], "shot blocked by budget");
    throw new JobError(reserved.decision.code, reserved.decision.message, false, reserved.decision.code === "unknown_price_unauthorized" ? "Authorise a number of unknown-price requests in the project budget, or enter the model's price in Settings." : "Raise the project budget or supply your own images.");
  }
  await ctx.stage("preparing references");
  const refs = await referenceImages(ctx, doc, scene);
  const chars = doc.characters.filter((c) => shot.characterIds.includes(c.id));
  const prompt = [shot.prompt, shot.continuity && `Continuity: ${shot.continuity}`, ...chars.map((c) => `${c.name}: ${c.notes || `${c.species} character, body ${c.palette.body}, accent ${c.palette.accent}`}`)].filter(Boolean).join("\n").slice(0, 4000);
  await updateGen(genId, { input: { model: model.model, prompt, aspectRatio: doc.format.aspect, references: refs.map((r) => r.id) } });
  if (!keyframe) await applyWithRetry(ctx, (d) => (d.scenes.find((s) => s.id === sceneId)?.shot?.status === "accepted" ? [] : [{ op: "setShotStatus", sceneId, status: "generating", variant }]), "shot generating");
  await ctx.stage(keyframe ? "generating keyframe with OpenRouter" : "generating with OpenRouter");
  let result;
  try {
    result = await new OpenRouterImages(key).generate({ model: model.model, prompt, references: refs.map(({ mediaType, data }) => ({ mediaType, data })), aspectRatio: doc.format.aspect, signal: ctx.signal });
  } catch (e) {
    const err = e instanceof MediaProviderError ? e : new MediaProviderError("network_uncertain", String(e), false);
    if (err.code === "network_uncertain") {
      await updateGen(genId, { state: "uncertain", error: { message: err.message } });
      throw new JobError("provider_uncertain", `${err.message} It was not resent (it may have been billed).`, false, "Check your OpenRouter activity page, then use Regenerate if needed.");
    }
    await updateGen(genId, { state: "failed", error: { message: err.message, retryable: err.retryable, code: err.code } });
    await releaseSpend(db, ctx.job.workspaceId, operationId);
    if (!err.retryable && !keyframe) await applyWithRetry(ctx, () => [{ op: "setShotStatus", sceneId, status: "failed", error: err.message.slice(0, 300) }], "shot generation failed");
    throw new JobError(err.code, err.message, err.retryable, err.code === "credentials_invalid" ? "Check the OpenRouter key in Settings." : undefined);
  }
  await updateGen(genId, { requestId: result.id, state: "succeeded", output: { model: result.model, costUsd: result.costUsd, images: result.images.length } });
  await ctx.stage("saving image");
  const first = result.images[0]!;
  let bytes: Buffer;
  const inline = decodeDataUrl(first);
  if (inline) bytes = inline.bytes;
  else {
    try {
      bytes = (await safeFetch(first, { maxBytes: 50 * 1024 * 1024, allowedTypes: /^image\//, signal: ctx.signal, timeoutMs: 120_000, ...outputFetchOptions() })).body;
    } catch (e) {
      throw new JobError(e instanceof UnsafeUrlError ? e.code : "download_failed", `The generated image could not be downloaded: ${(e as Error).message}`, false);
    }
  }
  const raw = join(ctx.workDir, "gen-image");
  await writeFile(raw, bytes);
  const out = join(ctx.workDir, "shot.png");
  await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", raw, "-frames:v", "1", out], { timeoutMs: 60_000 });
  const asset = await registerFile(ctx.job.workspaceId, out, {
    kind: "image",
    originalName: `${keyframe ? "keyframe" : "generated"}-${scene.purpose.replace(/\W+/g, "-").toLowerCase()}-v${variant}.png`,
    generated: true,
    provenance: { source: "generated", provider: "openrouter", ...(keyframe ? { role: "keyframe" } : {}), model: result.model ?? model.model, requestId: result.id, operationId, prompt: shot.prompt, referenceAssetIds: refs.map((r) => r.id), projectId: ctx.job.projectId, sceneId, generatedAt: new Date().toISOString(), reportedCostUsd: result.costUsd },
  });
  // Settle at the cost OpenRouter reported; otherwise at the owner-entered price.
  await settleSpend(db, ctx.job.workspaceId, operationId, result.costUsd !== null ? Math.round(result.costUsd * 1_000_000) : model.priceMicros);
  await updateGen(genId, { assetId: asset.id });
  let review: ShotReview | undefined;
  if (refs[0]) {
    await ctx.stage("checking fidelity");
    const ref = (await resolveAssets(ctx.job.workspaceId, [refs[0].id])).get(refs[0].id);
    if (ref) review = { referenceAssetId: refs[0].id, ...(await productFidelity(out, ref.path, undefined)), decision: "pending" };
  }
  g = (await db.query.generationRequests.findFirst({ where: eq(schema.generationRequests.id, genId) }))!;
  return attach(ctx, sceneId, g, asset.id, review, keyframe);
}

/**
 * Image shot through the owner's ChatGPT plan (local Codex CLI signed in with ChatGPT). No money is
 * spent, so the paid-spend ledger is not involved; a plan usage limit pauses the job like Claude's.
 * An interrupted run costs no money, so it is simply generated again.
 */
async function generateViaCodex(ctx: JobContext, doc: ProjectDocument, scene: Scene, variant: number, operationId: string, keyframe = false) {
  const db = getDb();
  const sceneId = scene.id;
  const shot = scene.shot!;
  let g = await db.query.generationRequests.findFirst({ where: and(eq(schema.generationRequests.workspaceId, ctx.job.workspaceId), eq(schema.generationRequests.operationId, operationId)) });
  if (g?.state === "succeeded" && g.assetId) return attach(ctx, sceneId, g, g.assetId, undefined, keyframe);
  if (g?.state === "failed" && !(g.error as { retryable?: boolean } | null)?.retryable) throw new JobError("provider_failed", String((g.error as { message?: string })?.message ?? "Generation failed."), false, "Adjust the prompt and use Regenerate.");
  const genId = g?.id ?? newId("gen");
  const values = { workspaceId: ctx.job.workspaceId, projectId: ctx.job.projectId, jobId: ctx.job.id, operationId, provider: "codex", endpoint: "chatgpt-image", capability: "image" as const, state: "submitting" as const, input: {}, requestId: null, error: null };
  if (g) await db.update(schema.generationRequests).set({ ...values, updatedAt: sql`now()` }).where(eq(schema.generationRequests.id, genId));
  else await db.insert(schema.generationRequests).values({ id: genId, ...values });

  await ctx.stage("preparing references");
  const refs = await referenceImages(ctx, doc, scene);
  const chars = doc.characters.filter((c) => shot.characterIds.includes(c.id));
  const prompt = [shot.prompt, shot.continuity && `Continuity: ${shot.continuity}`, ...chars.map((c) => `${c.name}: ${c.notes || `${c.species} character, body ${c.palette.body}, accent ${c.palette.accent}`}`)].filter(Boolean).join("\n").slice(0, 4000);
  await updateGen(genId, { input: { prompt, aspectRatio: doc.format.aspect, references: refs.map((r) => r.id) } });
  if (!keyframe) await applyWithRetry(ctx, (d) => (d.scenes.find((s) => s.id === sceneId)?.shot?.status === "accepted" ? [] : [{ op: "setShotStatus", sceneId, status: "generating", variant }]), "shot generating");
  await ctx.stage(keyframe ? "generating keyframe with ChatGPT" : "generating with ChatGPT");
  let result;
  try {
    // referenceImages() leaves each reference as ref-<i>.jpg in the job's work dir.
    result = await new CodexImages().generate({ prompt, referencePaths: refs.map((_, i) => resolve(ctx.workDir, `ref-${i}.jpg`)), aspectRatio: doc.format.aspect, cwd: resolve(ctx.workDir), signal: ctx.signal });
  } catch (e) {
    const err = e instanceof CodexError ? e : new CodexError("provider_failed", String(e), false);
    // A usage limit pauses the job; it must run again on Resume, so it stays retryable here.
    await updateGen(genId, { state: "failed", error: { message: err.message, retryable: err.retryable || err.code === "usage_limit", code: err.code } });
    if (err.code !== "usage_limit" && err.code !== "canceled" && !keyframe) await applyWithRetry(ctx, () => [{ op: "setShotStatus", sceneId, status: "failed", error: err.message.slice(0, 300) }], "shot generation failed");
    throw new JobError(err.code, err.message, err.retryable, err.recovery);
  }
  await updateGen(genId, { requestId: result.threadId, state: "succeeded", output: { threadId: result.threadId } });
  await ctx.stage("saving image");
  const out = join(ctx.workDir, "shot.png");
  await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", result.file, "-frames:v", "1", out], { timeoutMs: 60_000 });
  const asset = await registerFile(ctx.job.workspaceId, out, {
    kind: "image",
    originalName: `${keyframe ? "keyframe" : "generated"}-${scene.purpose.replace(/\W+/g, "-").toLowerCase()}-v${variant}.png`,
    generated: true,
    provenance: { source: "generated", provider: "codex", ...(keyframe ? { role: "keyframe" } : {}), model: "ChatGPT image (Codex CLI)", requestId: result.threadId, operationId, prompt: shot.prompt, referenceAssetIds: refs.map((r) => r.id), projectId: ctx.job.projectId, sceneId, generatedAt: new Date().toISOString(), billing: "ChatGPT plan" },
  });
  await updateGen(genId, { assetId: asset.id });
  let review: ShotReview | undefined;
  if (refs[0]) {
    await ctx.stage("checking fidelity");
    const ref = (await resolveAssets(ctx.job.workspaceId, [refs[0].id])).get(refs[0].id);
    if (ref) review = { referenceAssetId: refs[0].id, ...(await productFidelity(out, ref.path, undefined)), decision: "pending" };
  }
  g = (await db.query.generationRequests.findFirst({ where: eq(schema.generationRequests.id, genId) }))!;
  return attach(ctx, sceneId, g, asset.id, review, keyframe);
}

async function failGenerated(ctx: JobContext, g: GenRow, operationId: string, sceneId: string, message: string, keyframe = false): Promise<never> {
  // fal failures after queueing may still be billed by fal; keep the reservation settled at
  // the estimate unless the owner reconciles it, and say so.
  await settleSpend(getDb(), ctx.job.workspaceId, operationId, null);
  if (!keyframe) await applyWithRetry(ctx, () => [{ op: "setShotStatus", sceneId, status: "failed", error: message.slice(0, 300) }], "shot generation failed");
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
