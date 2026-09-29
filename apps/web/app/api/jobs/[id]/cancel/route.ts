import { getDb, getJob, notFound, requestCancel } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";
import { serializeJob } from "@/lib/server/serialize";

/** Best-effort cancellation (a provider may still bill for work already started). */
export const POST = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const db = getDb();
  const j = await getJob(db, id, s.workspaceId);
  if (!j) throw notFound("Job");
  const r = await requestCancel(db, j);
  return json({ job: serializeJob(r) });
});
