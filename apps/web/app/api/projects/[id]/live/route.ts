import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { dataDir, getDb, getJob, retryJob } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";
import { serializeJob } from "@/lib/server/serialize";

/**
 * Request the live-preview bundle for a revision (built by a worker in seconds, cached per
 * revision). Repeated calls for the same revision reuse one job; a failed one is retried.
 */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ revisionId: z.string().max(64) }));
  const r = await enqueueProjectJob(s, id, "live_preview", b.revisionId, {}, b.revisionId);
  // A succeeded job whose bundle was pruned (disposable cache) is rebuilt instead of pointing at nothing.
  const key = (r.job.result as { key?: string } | null)?.key;
  const pruned = r.job.status === "succeeded" && (!key || !/^[0-9a-f]{24}$/.test(key) || !(await stat(join(dataDir(), "live", key, "bundle", "index.html")).catch(() => null)));
  if (!r.created && (r.job.status === "failed" || r.job.status === "canceled" || pruned)) {
    const db = getDb();
    const j = await getJob(db, r.job.id, s.workspaceId);
    if (j) return json({ ...r, job: serializeJob(await db.transaction((tx) => retryJob(tx, j, { force: pruned }))) }, 202);
  }
  return json(r, 202);
});
