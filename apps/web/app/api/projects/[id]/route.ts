import { z } from "zod";
import { deleteProject, getDb, setProjectStatus } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";
import { projectView } from "@/lib/server/projects";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  return json(await projectView(id, s.workspaceId));
});

export const PATCH = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ status: z.enum(["active", "archived"]) }));
  await setProjectStatus(getDb(), id, s.workspaceId, b.status);
  return json({ ok: true });
});

export const DELETE = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const r = await getDb().transaction((tx) => deleteProject(tx, id, s.workspaceId));
  return json({ ok: true, purgeAfter: r.purgeAfter, canceledJobs: r.canceledJobs });
});

