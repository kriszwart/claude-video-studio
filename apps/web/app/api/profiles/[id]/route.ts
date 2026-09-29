import { z } from "zod";
import { getDb, getProfile, saveProfileVersion } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  return json(await getProfile(getDb(), id, s.workspaceId));
});

/** Save a new version (explicit). Stale bases are refused; the stored summary is the real diff. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ baseVersion: z.number().int().positive(), data: z.record(z.string(), z.unknown()), reasons: z.array(z.object({ field: z.string().max(40), because: z.string().max(300).optional() })).max(20).optional() }));
  const db = getDb();
  const r = await db.transaction((tx) => saveProfileVersion(tx, id, s.workspaceId, { baseVersion: b.baseVersion, data: b.data, reasons: b.reasons as never }));
  return json(r, 201);
});
