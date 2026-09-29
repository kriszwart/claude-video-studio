import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { getDb, notFound, schema } from "@vs/db";
import { BrandSnapshot } from "@vs/domain";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";

/** Brand kit edits bump its version; projects keep their snapshot until the owner applies the change. */
export const PATCH = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ name: z.string().min(1).max(80), data: BrandSnapshot }));
  const [row] = await getDb()
    .update(schema.brandKits)
    .set({ name: b.name, data: b.data, version: sql`${schema.brandKits.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(schema.brandKits.id, id), eq(schema.brandKits.workspaceId, s.workspaceId)))
    .returning();
  if (!row) throw notFound("Brand kit");
  return json({ brandKit: row });
});

export const DELETE = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  await getDb().update(schema.brandKits).set({ archived: true }).where(and(eq(schema.brandKits.id, id), eq(schema.brandKits.workspaceId, s.workspaceId)));
  return json({ ok: true });
});
