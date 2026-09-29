import { getDb, restoreDeletedProject } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";

export const POST = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  await getDb().transaction((tx) => restoreDeletedProject(tx, id, s.workspaceId));
  return json({ ok: true });
});
