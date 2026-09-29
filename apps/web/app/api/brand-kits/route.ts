import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getDb, newId, schema } from "@vs/db";
import { BrandSnapshot } from "@vs/domain";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";

export const GET = route(async () => {
  const s = await requireSession();
  const rows = await getDb().query.brandKits.findMany({ where: and(eq(schema.brandKits.workspaceId, s.workspaceId), eq(schema.brandKits.archived, false)), orderBy: desc(schema.brandKits.updatedAt) });
  return json({ brandKits: rows.map((r) => ({ id: r.id, name: r.name, version: r.version, data: r.data, updatedAt: r.updatedAt })) });
});

export const POST = route(async (req) => {
  const s = await requireSession();
  const b = await body(req, z.object({ name: z.string().min(1).max(80), data: BrandSnapshot }));
  const [row] = await getDb().insert(schema.brandKits).values({ id: newId("bk"), workspaceId: s.workspaceId, name: b.name, data: { ...b.data, name: b.data.name || b.name } }).returning();
  return json({ brandKit: row }, 201);
});
