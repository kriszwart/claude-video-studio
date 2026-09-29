import { hostname } from "node:os";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { closeDb, dispatchOutbox, getDb, reapExpiredLeases, requeueStranded, schema, syncBuiltinTemplates } from "@vs/db";
import { BUILTIN_TEMPLATES } from "@vs/templates";
import { shutdownRenderer } from "@vs/rendering";
import { sql } from "drizzle-orm";
import { assistantEdit, planStoryboard } from "./handlers/ai";
import { runCleanup } from "./handlers/cleanup";
import { ingestAsset } from "./handlers/ingest";
import { renderKeyframes } from "./handlers/keyframes";
import { renderRevision } from "./handlers/render";
import { seedSample } from "./handlers/seed";
import { extraHandlers } from "./handlers/extra";
import { workerCapabilities } from "./capabilities";
import { runJob } from "./runner";

const QUEUE = process.env.QUEUE_NAME ?? "vs-jobs";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const newConnection = () => new Redis(redisUrl, { maxRetriesPerRequest: null });
const workerId = `${hostname()}:${process.pid}`;
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);

function log(msg: string, data: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), worker: workerId, msg, ...data })}\n`);
}

const handlers = {
  ingest_asset: ingestAsset,
  plan: planStoryboard,
  assistant: assistantEdit,
  preview: renderRevision,
  export: renderRevision,
  keyframes: renderKeyframes,
  seed_sample: seedSample,
  ...extraHandlers,
};

async function main() {
  await syncBuiltinTemplates(getDb(), BUILTIN_TEMPLATES);
  const queue = new Queue(QUEUE, { connection: newConnection() });
  const worker = new Worker(
    QUEUE,
    async (m) => {
      await runJob(String(m.data.jobId), { workerId, handlers, log });
    },
    { connection: newConnection(), concurrency, lockDuration: 120_000, removeOnComplete: { count: 1000 }, removeOnFail: { count: 1000 } },
  );
  worker.on("error", (e) => log("queue error", { error: String(e) }));

  const publish = async (job: { id: string; type: string; runAfter: Date }) => {
    const delay = Math.max(0, job.runAfter.getTime() - Date.now());
    // jobId + attempt marker keeps BullMQ deduplication while allowing retries to republish.
    await queue.add(job.type, { jobId: job.id }, { jobId: `${job.id}-${Date.now()}`, delay, removeOnComplete: true, removeOnFail: true });
  };
  let stopping = false;
  const loops: NodeJS.Timeout[] = [];
  loops.push(setInterval(() => void dispatchOutbox(publish).catch((e) => log("dispatch error", { error: String(e) })), 500));
  loops.push(setInterval(() => void reapExpiredLeases().then((n) => n && log("reaped expired leases", { n })).catch((e) => log("reaper error", { error: String(e) })), 10_000));
  loops.push(setInterval(() => void requeueStranded().then((n) => n && log("requeued stranded jobs", { n })).catch(() => {}), 60_000));
  loops.push(setInterval(() => void runCleanup().catch((e) => log("cleanup error", { error: String(e) })), 60_000));
  const caps = await workerCapabilities();
  const beat = async () => {
    await getDb()
      .insert(schema.workerCapabilities)
      .values({ workerId, capabilities: caps })
      .onConflictDoUpdate({ target: schema.workerCapabilities.workerId, set: { capabilities: caps, heartbeatAt: sql`now()` } });
  };
  await beat();
  loops.push(setInterval(() => void beat().catch(() => {}), 15_000));
  log("worker started", { queue: QUEUE, concurrency, capabilities: caps });

  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log("shutting down", { sig });
    loops.forEach(clearInterval);
    await worker.close();
    await queue.close();
    await shutdownRenderer().catch(() => {});
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  log("fatal", { error: String(e?.stack ?? e) });
  process.exit(1);
});
