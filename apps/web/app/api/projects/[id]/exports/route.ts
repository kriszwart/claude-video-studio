import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { getDb, getProject, schema } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";
import { serializeExport } from "@/lib/server/serialize";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  await getProject(getDb(), id, s.workspaceId);
  const rows = await getDb().query.exportsTable.findMany({ where: eq(schema.exportsTable.projectId, id), orderBy: desc(schema.exportsTable.createdAt) });
  return json({ exports: rows.map(serializeExport) });
});

export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ revisionId: z.string().max(64).optional() }));
  const r = await enqueueProjectJob(s, id, "export", b.revisionId, {}, idempotencyKey(req));
  return json(r, 202);
});
