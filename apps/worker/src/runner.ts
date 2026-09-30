import { claimJob, completeJob, failJob, heartbeat, JobError, markCanceled, redact, type JobRow } from "@vs/db";
import { cleanupWorkDir, jobWorkDir, makeStage, type Handler, type JobContext } from "./context";
import { toJobError } from "./handlers/ai";

export interface RunnerDeps {
  workerId: string;
  handlers: Partial<Record<string, Handler>>;
  leaseSec?: number;
  heartbeatMs?: number;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

/**
 * Execute one job end to end. The database row is authoritative: the queue message only
 * says "look at job X". A job that cannot be claimed (canceled, already running, not due)
 * is skipped.
 */
export async function runJob(jobId: string, deps: RunnerDeps): Promise<"done" | "skipped"> {
  const job = await claimJob(jobId, deps.workerId, deps.leaseSec ?? 90);
  if (!job) return "skipped";
  const handler = deps.handlers[job.type];
  const controller = new AbortController();
  const log = (msg: string, data?: Record<string, unknown>) => deps.log(msg, { jobId, type: job.type, ...data });
  let leaseLost = false;
  const hb = setInterval(async () => {
    try {
      const { cancelRequested } = await heartbeat(jobId, deps.workerId, deps.leaseSec ?? 90);
      if (cancelRequested && !controller.signal.aborted) {
        log("cancel requested; aborting");
        controller.abort(new Error("canceled"));
      }
    } catch {
      leaseLost = true;
      controller.abort(new Error("lease lost"));
    }
  }, deps.heartbeatMs ?? 15_000);

  const workDir = await jobWorkDir(jobId);
  const ctx: JobContext = { job, workerId: deps.workerId, signal: controller.signal, workDir, stage: makeStage(job, deps.workerId), log };
  const started = Date.now();
  try {
    if (!handler) throw new JobError("unsupported_job", `This worker cannot run "${job.type}" jobs.`, false);
    log("job started", { attempt: job.attempts });
    const result = await handler(ctx);
    if (controller.signal.aborted && !leaseLost) {
      await markCanceled(jobId, deps.workerId);
      return "done";
    }
    await completeJob(jobId, deps.workerId, { ...result, elapsedMs: Date.now() - started });
    log("job succeeded", { ms: Date.now() - started });
  } catch (e) {
    if (leaseLost) {
      log("lease lost; abandoning result");
      return "done";
    }
    if (controller.signal.aborted) {
      await failJob(jobId, deps.workerId, { code: "canceled", message: "Canceled by request.", retryable: false });
      return "done";
    }
    const je = toJobError(e);
    log("job failed", { code: je.code, message: redact(je.message), retryable: je.retryable });
    await failJob(jobId, deps.workerId, { code: je.code, message: redact(je.message), retryable: je.retryable, recovery: je.recovery, ...(je.details ? { details: je.details } : {}) });
  } finally {
    clearInterval(hb);
    await cleanupWorkDir(jobId);
  }
  return "done";
}

export type { JobRow };
