import { getDb, getProject, listRevisions } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  await getProject(getDb(), id, s.workspaceId);
  return json({ revisions: await listRevisions(getDb(), id, 100) });
});
