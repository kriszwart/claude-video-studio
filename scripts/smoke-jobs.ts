/** Drive seed → keyframes → preview through the real job system (DB + outbox + queue + worker). */
import { eq } from "drizzle-orm";
import { closeDb, enqueueJob, ensureLocalOwner, getDb, schema } from "@vs/db";

const db = getDb();
const owner = await ensureLocalOwner(db);
async function waitFor(jobId: string, timeoutMs = 600_000) {
  const t0 = Date.now();
  let lastStage = "";
  while (Date.now() - t0 < timeoutMs) {
    const j = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
    if (j && j.stage !== lastStage) {
      lastStage = j.stage;
      console.log(`  [${j.type}] ${j.status} · ${j.stage}${j.progress != null ? ` ${Math.round(j.progress * 100)}%` : ""}`);
    }
    if (j && ["succeeded", "failed", "canceled"].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("timeout");
}
const seed = await enqueueJob(db, { workspaceId: owner.workspaceId, type: "seed_sample", input: {}, idempotencyKey: "seed-sample" });
const s = await waitFor(seed.job.id);
console.log("seed:", s.status, s.result ?? s.error);
const projectId = String(s.result!.projectId);
const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
const kf = await enqueueJob(db, { workspaceId: owner.workspaceId, projectId, revisionId: project!.currentRevisionId, type: "keyframes", input: {} });
const k = await waitFor(kf.job.id);
console.log("keyframes:", k.status, JSON.stringify(k.result ?? k.error).slice(0, 300));
const pv = await enqueueJob(db, { workspaceId: owner.workspaceId, projectId, revisionId: project!.currentRevisionId, type: "preview", input: {} });
const p = await waitFor(pv.job.id);
console.log("preview:", p.status, JSON.stringify(p.result ?? p.error).slice(0, 600));
await closeDb();
