import { z } from "zod";
import { getDb, reserveCollectionUpload } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";
import { serializeAsset } from "@/lib/server/serialize";

/**
 * Reserve a browser-selected file for the collection. Re-selecting the same file (same
 * relative path and size) returns the existing item: the client skips it when already
 * uploaded or resumes its chunked upload from the server's received offset (A20).
 */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ filename: z.string().min(1).max(255), relativePath: z.string().max(400).optional(), mime: z.string().max(100), bytes: z.number().int().positive(), rightsAcknowledged: z.boolean() }));
  const r = await reserveCollectionUpload(getDb(), s.workspaceId, id, b);
  return json({ item: r.item, asset: r.asset ? serializeAsset(r.asset) : null, uploadUrl: r.asset ? `/api/assets/${r.asset.id}/content` : null, created: r.created }, r.created ? 201 : 200);
});
