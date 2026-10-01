import { and, desc, eq, sql } from "drizzle-orm";
import { AppError, enqueueJob, getAsset, getDb, getStore, retryJob, schema } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";
import { serializeJob } from "@/lib/server/serialize";

/**
 * Process a failed upload again, e.g. after its file was missing at the time and has since been
 * restored. Only when the stored file is really there; a file that was rejected for its content
 * (wrong type, too large) needs a different upload, not another try.
 */
export const POST = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const db = getDb();
  const a = await getAsset(db, id, s.workspaceId);
  if (a.status !== "failed") throw new AppError(409, "not_failed", "Only a failed upload can be processed again.");
  const size = await getStore().size(a.storageKey).catch(() => -1);
  if (size <= 0) throw new AppError(409, "upload_missing", "The file for this upload is not in storage.", "Upload the file again.");
  const last = await db.query.jobs.findFirst({
    where: and(eq(schema.jobs.workspaceId, s.workspaceId), eq(schema.jobs.type, "ingest_asset"), sql`${schema.jobs.input}->>'assetId' = ${id}`),
    orderBy: desc(schema.jobs.createdAt),
  });
  if (last?.error && !["upload_missing", "internal"].includes(last.error.code)) throw new AppError(409, "needs_new_upload", last.error.message ?? "This file was rejected.", "Upload a different file.");
  const job = await db.transaction(async (tx) => {
    await tx.update(schema.assets).set({ status: "pending", error: null }).where(eq(schema.assets.id, id));
    return last ? retryJob(tx, last) : (await enqueueJob(tx, { workspaceId: s.workspaceId, type: "ingest_asset", input: { assetId: id }, idempotencyKey: `ingest:${id}` })).job;
  });
  return json({ job: serializeJob(job) }, 202);
});
