import { AppError, getDb, getJob, notFound, retryJob } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";
import { serializeJob } from "@/lib/server/serialize";

const NON_RETRYABLE = new Set(["invalid_timeline", "missing_inputs", "credentials_missing", "budget_exceeded", "unknown_price_unauthorized", "invalid_media", "invalid_image", "invalid_font", "invalid_svg", "too_large", "too_long", "unsupported_type"]);

export const POST = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const db = getDb();
  const j = await getJob(db, id, s.workspaceId);
  if (!j) throw notFound("Job");
  if (j.error && NON_RETRYABLE.has(j.error.code)) throw new AppError(409, "needs_correction", "This failure needs a correction (input, credentials or budget) rather than a retry.", j.error.recovery);
  const r = await db.transaction((tx) => retryJob(tx, j));
  return json({ job: serializeJob(r) });
});
