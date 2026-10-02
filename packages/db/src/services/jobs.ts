import { and, asc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../client";
import { getDb } from "../client";
import { newId } from "../ids";
import { jobEvents, jobs, outbox, projectRevisions, workerCapabilities } from "../schema";

export type JobRow = typeof jobs.$inferSelect;
export type JobStatus = JobRow["status"];

export const JOB_TYPES = [
  "ingest_asset",
  "import_url",
  "plan",
  "compose",
  "write_script",
  "critique",
  "check_fidelity",
  "send_lanternist",
  "place_sfx",
  "plan_demo",
  "lock_music",
  "export_otio",
  "generate_music",
  "assistant",
  "keyframes",
  "live_preview",
  "preview",
  "export",
  "tts",
  "transcribe",
  "propose_cuts",
  "generate_image",
  "match_footage",
  "generate_media",
  "recover_generation",
  "generate_video",
  "quality_review",
  "analyze_music",
  "analyze_reference",
  "collection_ingest",
  "build_sizzle",
  "screenshot_capture",
  "cleanup",
  "seed_sample",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export interface EnqueueInput {
  workspaceId: string;
  projectId?: string | null;
  revisionId?: string | null;
  type: JobType;
  input: Record<string, unknown>;
  idempotencyKey?: string | null;
  maxAttempts?: number;
  parentJobId?: string | null;
  runAfter?: Date;
}

export class JobError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable: boolean,
    public recovery?: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Errors that pause a job instead of failing it: the work is resumable once the owner acts
 * (e.g. a subscription usage window resets). A paused job is never retried automatically.
 */
export const PAUSING_ERRORS = new Set(["usage_limit"]);

/** Jobs that compile the composition and therefore need the graphics backends it uses. */
const GRAPHICS_JOBS = new Set<string>(["preview", "export", "keyframes", "live_preview", "quality_review", "critique"]);

/** Graphics backends a revision needs (FR-21 capability routing). */
export async function graphicsRequirements(db: DbOrTx, revisionId: string): Promise<string[]> {
  const rev = await db.query.projectRevisions.findFirst({ where: eq(projectRevisions.id, revisionId), columns: { document: true } });
  const doc = rev?.document as { scenes?: { layers?: { kind: string; backend?: string; hidden?: boolean }[] }[] } | undefined;
  const set = new Set<string>();
  for (const s of doc?.scenes ?? []) for (const l of s.layers ?? []) if (l.kind === "graphics" && !l.hidden && l.backend) set.add(l.backend);
  return [...set].sort();
}

/** Queue carrying jobs with these requirements; workers subscribe only to queues they can run. */
export function queueNameFor(base: string, requires: string[]): string {
  return requires.length ? `${base}-${[...requires].sort().join("-")}` : base;
}

/** Whether a live worker (heartbeat in the last 2 minutes) offers every required backend. */
export async function routingStatus(db: DbOrTx, requires: string[]) {
  if (!requires.length) return { blocked: false as const };
  const live = await db.query.workerCapabilities.findMany({ where: gt(workerCapabilities.heartbeatAt, new Date(Date.now() - 120_000)) });
  const ok = live.some((w) => requires.every((r) => (w.capabilities as { graphics?: Record<string, unknown> }).graphics?.[r] === true));
  if (ok) return { blocked: false as const };
  const names = requires.map((r) => (r === "redraw" ? "Redraw (WebGPU)" : r === "skia" ? "Skia" : r)).join(" + ");
  return { blocked: true as const, reason: `No online worker can render ${names} layers. The job waits until a compatible worker is available; you can cancel it, or hide/replace those layers with a reviewed alternative.` };
}

/** Insert job + outbox row atomically. Duplicate idempotency keys return the original job. */
export async function enqueueJob(db: DbOrTx, input: EnqueueInput): Promise<{ job: JobRow; created: boolean }> {
  if (input.idempotencyKey) {
    const existing = await db.query.jobs.findFirst({ where: and(eq(jobs.workspaceId, input.workspaceId), eq(jobs.idempotencyKey, input.idempotencyKey)) });
    if (existing) return { job: existing, created: false };
  }
  let stage = "queued";
  if (GRAPHICS_JOBS.has(input.type) && input.revisionId) {
    const requires = await graphicsRequirements(db, input.revisionId);
    input = { ...input, input: { ...input.input, requires } };
    const r = await routingStatus(db, requires);
    if (r.blocked) stage = "waiting for a compatible worker";
  }
  const id = newId("job");
  const [job] = await db
    .insert(jobs)
    .values({
      id,
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      revisionId: input.revisionId ?? null,
      type: input.type,
      input: input.input,
      idempotencyKey: input.idempotencyKey ?? null,
      maxAttempts: input.maxAttempts ?? 3,
      parentJobId: input.parentJobId ?? null,
      runAfter: input.runAfter ?? new Date(),
      stage,
    })
    .onConflictDoNothing({ target: [jobs.workspaceId, jobs.idempotencyKey] })
    .returning();
  if (!job) {
    // Lost a race on the idempotency key.
    const existing = await db.query.jobs.findFirst({ where: and(eq(jobs.workspaceId, input.workspaceId), eq(jobs.idempotencyKey, input.idempotencyKey!)) });
    return { job: existing!, created: false };
  }
  await db.insert(outbox).values({ jobId: id });
  await emitJobEvent(db, job, "queued", { stage });
  return { job, created: true };
}

export async function emitJobEvent(db: DbOrTx, job: Pick<JobRow, "id" | "projectId" | "workspaceId">, kind: string, data: Record<string, unknown> = {}) {
  await db.insert(jobEvents).values({ jobId: job.id, projectId: job.projectId, workspaceId: job.workspaceId, kind, data });
}

/** Claim a job for execution with a lease. Returns null when the job is not claimable. */
export async function claimJob(jobId: string, workerId: string, leaseSec = 90): Promise<JobRow | null> {
  const db = getDb();
  const [row] = await db
    .update(jobs)
    .set({
      status: "running",
      stage: "starting",
      attempts: sql`${jobs.attempts} + 1`,
      leaseOwner: workerId,
      leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSec})`,
      startedAt: sql`coalesce(${jobs.startedAt}, now())`,
      updatedAt: sql`now()`,
      error: null,
    })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "queued"), lte(jobs.runAfter, sql`now()`)))
    .returning();
  if (!row) return null;
  await emitJobEvent(db, row, "running", { attempt: row.attempts });
  return row;
}

/** Extend the lease; returns whether cancellation was requested. Throws if the lease was lost. */
export async function heartbeat(jobId: string, workerId: string, leaseSec = 90): Promise<{ cancelRequested: boolean }> {
  const db = getDb();
  const [row] = await db
    .update(jobs)
    .set({ leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSec})`, updatedAt: sql`now()` })
    .where(and(eq(jobs.id, jobId), eq(jobs.leaseOwner, workerId), inArray(jobs.status, ["running", "waiting_provider", "cancel_requested"])))
    .returning({ status: jobs.status });
  if (!row) throw new JobError("lease_lost", "This worker no longer holds the job lease.", false);
  return { cancelRequested: row.status === "cancel_requested" };
}

export async function setStage(jobId: string, workerId: string, stage: string, progress: number | null, extra: Record<string, unknown> = {}) {
  const db = getDb();
  const [row] = await db
    .update(jobs)
    .set({ stage, progress, updatedAt: sql`now()` })
    .where(and(eq(jobs.id, jobId), eq(jobs.leaseOwner, workerId)))
    .returning();
  if (row) await emitJobEvent(db, row, "stage", { stage, progress, ...extra });
}

export async function setWaitingProvider(jobId: string, workerId: string, providerRequestId: string) {
  const db = getDb();
  const [row] = await db
    .update(jobs)
    .set({ status: "waiting_provider", providerRequestId, updatedAt: sql`now()` })
    .where(and(eq(jobs.id, jobId), eq(jobs.leaseOwner, workerId), eq(jobs.status, "running")))
    .returning();
  if (row) await emitJobEvent(db, row, "waiting_provider", { providerRequestId });
}

export async function completeJob(jobId: string, workerId: string, result: Record<string, unknown>, onDone?: (tx: DbOrTx, job: JobRow) => Promise<void>) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(jobs)
      .set({ status: "succeeded", stage: "done", progress: 1, result, finishedAt: sql`now()`, leaseOwner: null, leaseExpiresAt: null, updatedAt: sql`now()` })
      .where(and(eq(jobs.id, jobId), eq(jobs.leaseOwner, workerId)))
      .returning();
    if (!row) throw new JobError("lease_lost", "Job lease lost before completion; result discarded.", false);
    if (onDone) await onDone(tx, row);
    await emitJobEvent(tx, row, "succeeded", { result: summarize(result) });
    return row;
  });
}

function summarize(result: Record<string, unknown>) {
  const s = JSON.stringify(result);
  return s.length > 4000 ? { truncated: true } : result;
}

export function backoffMs(attempt: number): number {
  const base = 5000 * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(base, 5 * 60_000) + Math.floor(Math.random() * 1000);
}

/** Record a failure: retry transient errors with backoff, otherwise fail permanently. */
export async function failJob(jobId: string, workerId: string, err: { code: string; message: string; retryable: boolean; recovery?: string; details?: Record<string, unknown> }) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const cur = await tx.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
    if (!cur || cur.leaseOwner !== workerId) return null;
    if (cur.status === "cancel_requested") {
      const [row] = await tx
        .update(jobs)
        .set({ status: "canceled", stage: "canceled", finishedAt: sql`now()`, leaseOwner: null, leaseExpiresAt: null, error: { code: "canceled", message: "Canceled by request." }, updatedAt: sql`now()` })
        .where(eq(jobs.id, jobId))
        .returning();
      await emitJobEvent(tx, row!, "canceled");
      return row;
    }
    if (PAUSING_ERRORS.has(err.code)) {
      const [row] = await tx
        .update(jobs)
        .set({ status: "paused", stage: "paused", leaseOwner: null, leaseExpiresAt: null, error: { ...err, retryable: false }, updatedAt: sql`now()` })
        .where(eq(jobs.id, jobId))
        .returning();
      await emitJobEvent(tx, row!, "paused", { error: err, attempt: cur.attempts });
      return row;
    }
    const retry = err.retryable && cur.attempts < cur.maxAttempts;
    const [row] = await tx
      .update(jobs)
      .set(
        retry
          ? { status: "queued", stage: "retry_scheduled", leaseOwner: null, leaseExpiresAt: null, runAfter: new Date(Date.now() + backoffMs(cur.attempts)), error: err, updatedAt: sql`now()` }
          : { status: "failed", stage: "failed", finishedAt: sql`now()`, leaseOwner: null, leaseExpiresAt: null, error: err, updatedAt: sql`now()` },
      )
      .where(eq(jobs.id, jobId))
      .returning();
    if (retry) await tx.insert(outbox).values({ jobId });
    await emitJobEvent(tx, row!, retry ? "retry_scheduled" : "failed", { error: err, attempt: cur.attempts });
    return row;
  });
}

export async function markCanceled(jobId: string, workerId: string) {
  const db = getDb();
  const [row] = await db
    .update(jobs)
    .set({ status: "canceled", stage: "canceled", finishedAt: sql`now()`, leaseOwner: null, leaseExpiresAt: null, updatedAt: sql`now()` })
    .where(and(eq(jobs.id, jobId), eq(jobs.leaseOwner, workerId)))
    .returning();
  if (row) await emitJobEvent(db, row, "canceled");
}

/** Best-effort cancellation. Queued jobs cancel immediately; running jobs are asked to stop. */
export async function requestCancel(db: DbOrTx, job: JobRow): Promise<JobRow> {
  if (job.status === "queued" || job.status === "paused") {
    const [row] = await db
      .update(jobs)
      .set({ status: "canceled", stage: "canceled", finishedAt: sql`now()`, cancelRequestedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(jobs.id, job.id), inArray(jobs.status, ["queued", "paused"])))
      .returning();
    if (row) {
      await emitJobEvent(db, row, "canceled");
      return row;
    }
  }
  if (job.status === "running" || job.status === "waiting_provider") {
    const [row] = await db
      .update(jobs)
      .set({ status: "cancel_requested", cancelRequestedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(jobs.id, job.id), inArray(jobs.status, ["running", "waiting_provider"])))
      .returning();
    if (row) {
      await emitJobEvent(db, row, "cancel_requested");
      return row;
    }
  }
  return (await db.query.jobs.findFirst({ where: eq(jobs.id, job.id) }))!;
}

/** Re-queue a finished job. `force` also re-runs a succeeded one (only for rebuildable caches, e.g. live previews). */
export async function retryJob(db: DbOrTx, job: JobRow, opts: { force?: boolean } = {}): Promise<JobRow> {
  if (![...["failed", "canceled", "uncertain", "paused"], ...(opts.force ? ["succeeded"] : [])].includes(job.status)) return job;
  const [row] = await db
    .update(jobs)
    .set({ status: "queued", stage: "queued", maxAttempts: job.attempts + 3, runAfter: sql`now()`, finishedAt: null, error: null, updatedAt: sql`now()` })
    .where(eq(jobs.id, job.id))
    .returning();
  await db.insert(outbox).values({ jobId: job.id });
  await emitJobEvent(db, row!, "queued", { retry: true });
  return row!;
}

/**
 * Recover jobs whose worker died (lease expired). Running jobs with attempts left
 * are re-queued; otherwise they fail. Jobs waiting on a provider become "uncertain"
 * only when a submission may have been made without a recorded request id.
 */
export async function reapExpiredLeases(): Promise<number> {
  const db = getDb();
  const expired = await db.query.jobs.findMany({
    where: and(inArray(jobs.status, ["running", "cancel_requested", "waiting_provider"]), lt(jobs.leaseExpiresAt, sql`now()`)),
    limit: 50,
  });
  for (const j of expired) {
    await db.transaction(async (tx) => {
      if (j.status === "cancel_requested") {
        const [row] = await tx.update(jobs).set({ status: "canceled", stage: "canceled", finishedAt: sql`now()`, leaseOwner: null, leaseExpiresAt: null }).where(eq(jobs.id, j.id)).returning();
        await emitJobEvent(tx, row!, "canceled", { reason: "worker lost after cancel request" });
        return;
      }
      if (j.status === "waiting_provider" && j.providerRequestId) {
        // A request id exists: another worker reconciles via provider status instead of resubmitting.
        const [row] = await tx.update(jobs).set({ status: "queued", stage: "reconcile_provider", leaseOwner: null, leaseExpiresAt: null, runAfter: sql`now()` }).where(eq(jobs.id, j.id)).returning();
        await tx.insert(outbox).values({ jobId: j.id });
        await emitJobEvent(tx, row!, "retry_scheduled", { reason: "worker lost; reconciling provider request" });
        return;
      }
      const err = { code: "worker_lost", message: "The worker stopped responding while running this job.", retryable: true };
      if (j.attempts < j.maxAttempts) {
        const [row] = await tx
          .update(jobs)
          .set({ status: "queued", stage: "retry_scheduled", leaseOwner: null, leaseExpiresAt: null, runAfter: new Date(Date.now() + backoffMs(j.attempts)), error: err })
          .where(eq(jobs.id, j.id))
          .returning();
        await tx.insert(outbox).values({ jobId: j.id });
        await emitJobEvent(tx, row!, "retry_scheduled", { error: err });
      } else {
        const [row] = await tx.update(jobs).set({ status: "failed", stage: "failed", finishedAt: sql`now()`, leaseOwner: null, leaseExpiresAt: null, error: err }).where(eq(jobs.id, j.id)).returning();
        await emitJobEvent(tx, row!, "failed", { error: err });
      }
    });
  }
  return expired.length;
}

/**
 * Publish unpublished outbox rows to the queue. `publish` must be idempotent per job id
 * (BullMQ dedupes on jobId), so a crash between publish and marking is harmless.
 */
export async function dispatchOutbox(publish: (job: JobRow) => Promise<void>, limit = 50): Promise<number> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(outbox)
      .where(isNull(outbox.publishedAt))
      .orderBy(asc(outbox.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    for (const r of rows) {
      const job = await tx.query.jobs.findFirst({ where: eq(jobs.id, r.jobId) });
      if (job && job.status === "queued") await publish(job);
      await tx.update(outbox).set({ publishedAt: sql`now()` }).where(eq(outbox.id, r.id));
    }
    return rows.length;
  });
}

/** Safety net: queued jobs that are due but were never delivered get a fresh outbox row. */
export async function requeueStranded(olderThanSec = 120): Promise<number> {
  const db = getDb();
  const rows = await db.execute(sql`
    insert into outbox (job_id)
    select j.id from jobs j
    where j.status = 'queued' and j.run_after < now() - make_interval(secs => ${olderThanSec})
      and j.updated_at < now() - make_interval(secs => ${olderThanSec})
      and not exists (select 1 from outbox o where o.job_id = j.id and o.published_at is null)
    returning job_id`);
  if (rows.rowCount) await db.execute(sql`update jobs set updated_at = now() where id in (select job_id from outbox where published_at is null)`);
  return rows.rowCount ?? 0;
}

export async function getJob(db: DbOrTx, id: string, workspaceId: string) {
  return db.query.jobs.findFirst({ where: and(eq(jobs.id, id), eq(jobs.workspaceId, workspaceId)) });
}

export async function activeJobsForProject(db: DbOrTx, projectId: string) {
  return db.query.jobs.findMany({
    where: and(eq(jobs.projectId, projectId), or(inArray(jobs.status, ["queued", "running", "waiting_provider", "cancel_requested", "uncertain"]))),
  });
}
