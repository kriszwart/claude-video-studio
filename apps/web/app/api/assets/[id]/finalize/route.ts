import { AppError, enqueueJob, getAsset, getDb, getStore } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";
import { serializeJob } from "@/lib/server/serialize";

/** Probe and validate an uploaded asset (async). */
export const POST = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const db = getDb();
  const a = await getAsset(db, id, s.workspaceId);
  const size = await getStore().size(a.storageKey).catch(() => -1);
  if (size <= 0) throw new AppError(409, "upload_incomplete", "Upload the file content before finalising.");
  const { job } = await enqueueJob(db, { workspaceId: s.workspaceId, type: "ingest_asset", input: { assetId: id }, idempotencyKey: `ingest:${id}` });
  return json({ job: serializeJob(job) }, 202);
});
