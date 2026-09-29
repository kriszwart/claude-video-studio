import { getDb, getJob, notFound } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";
import { serializeJob } from "@/lib/server/serialize";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const j = await getJob(getDb(), id, s.workspaceId);
  if (!j) throw notFound("Job");
  return json({ job: serializeJob(j) });
});
