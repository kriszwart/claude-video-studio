import { hostname } from "node:os";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { closeDb, dispatchOutbox, getDb, queueNameFor, reapExpiredLeases, requeueStranded, schema, syncBuiltinTemplates } from "@vs/db";
import { BUILTIN_TEMPLATES } from "@vs/templates";
import { shutdownRenderer } from "@vs/rendering";
import { sql } from "drizzle-orm";
import { assistantEdit, planStoryboard } from "./handlers/ai";
import { runCleanup } from "./handlers/cleanup";
import { ingestAsset } from "./handlers/ingest";
import { renderKeyframes } from "./handlers/keyframes";
import { livePreview } from "./handlers/livePreview";
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
  live_preview: livePreview,
  seed_sample: seedSample,
  ...extraHandlers,
};

async function main() {
  await syncBuiltinTemplates(getDb(), BUILTIN_TEMPLATES);
  const caps = await workerCapabilities();
  // Capability routing (FR-21): jobs whose composition needs graphics backends go to a queue
  // named after those backends; this worker only consumes queues it can actually run.
  const backends = (["redraw", "skia"] as const).filter((b) => caps.graphics[b]);
  const subsets = backends.reduce<string[][]>((acc, b) => [...acc, ...acc.map((x) => [...x, b])], [[]]);
  // Live previews get their own queues so the editor's player never waits behind a long export.
  const consumed = [...subsets.map((sub) => queueNameFor(QUEUE, sub)), ...subsets.map((sub) => queueNameFor(`${QUEUE}-live`, sub))];
  const queues = new Map<string, Queue>();
  const queueFor = (name: string) => {
    if (!queues.has(name)) queues.set(name, new Queue(name, { connection: newConnection() }));
    return queues.get(name)!;
  };
  const workers = consumed.map(
    (name, i) =>
      new Worker(
        name,
        async (m) => {
          await runJob(String(m.data.jobId), { workerId, handlers, log });
        },
        { connection: newConnection(), concurrency: i === 0 ? concurrency : name.includes("-live") ? 2 : 1, lockDuration: 120_000, removeOnComplete: { count: 1000 }, removeOnFail: { count: 1000 } },
      ),
  );
  for (const w of workers) w.on("error", (e) => log("queue error", { error: String(e) }));

  const publish = async (job: { id: string; type: string; runAfter: Date; input: unknown }) => {
    const delay = Math.max(0, job.runAfter.getTime() - Date.now());
    const requires = ((job.input as { requires?: string[] }).requires ?? []).filter((r) => r === "redraw" || r === "skia");
    // jobId + attempt marker keeps BullMQ deduplication while allowing retries to republish.
    await queueFor(queueNameFor(job.type === "live_preview" ? `${QUEUE}-live` : QUEUE, requires)).add(job.type, { jobId: job.id }, { jobId: `${job.id}-${Date.now()}`, delay, removeOnComplete: true, removeOnFail: true });
  };
  let stopping = false;
  const loops: NodeJS.Timeout[] = [];
  loops.push(setInterval(() => void dispatchOutbox(publish).catch((e) => log("dispatch error", { error: String(e) })), 500));
  loops.push(setInterval(() => void reapExpiredLeases().then((n) => n && log("reaped expired leases", { n })).catch((e) => log("reaper error", { error: String(e) })), 10_000));
  loops.push(setInterval(() => void requeueStranded().then((n) => n && log("requeued stranded jobs", { n })).catch(() => {}), 60_000));
  loops.push(setInterval(() => void runCleanup().catch((e) => log("cleanup error", { error: String(e) })), 60_000));
  const beat = async () => {
    await getDb()
      .insert(schema.workerCapabilities)
      .values({ workerId, capabilities: caps })
      .onConflictDoUpdate({ target: schema.workerCapabilities.workerId, set: { capabilities: caps, heartbeatAt: sql`now()` } });
  };
  await beat();
  loops.push(setInterval(() => void beat().catch(() => {}), 15_000));
  log("worker started", { queues: consumed, concurrency, capabilities: caps });

  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log("shutting down", { sig });
    loops.forEach(clearInterval);
    // Stop advertising capabilities first, so routing never counts this worker as available.
    await getDb().delete(schema.workerCapabilities).where(sql`${schema.workerCapabilities.workerId} = ${workerId}`).catch(() => {});
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all([...queues.values()].map((q) => q.close()));
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
