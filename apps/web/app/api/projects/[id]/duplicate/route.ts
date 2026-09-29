import { duplicateProject, getDb } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";

export const POST = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const r = await getDb().transaction((tx) => duplicateProject(tx, id, s.workspaceId));
  return json({ projectId: r.project.id }, 201);
});
