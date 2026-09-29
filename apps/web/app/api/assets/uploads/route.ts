import { z } from "zod";
import { createPendingAsset, getDb } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";
import { serializeAsset } from "@/lib/server/serialize";

/** Authorise an upload with type/size constraints; the client then PUTs the bytes. */
export const POST = route(async (req) => {
  const s = await requireSession();
  const b = await body(req, z.object({ filename: z.string().min(1).max(255), mime: z.string().max(100), bytes: z.number().int().positive(), rightsAcknowledged: z.boolean() }));
  const a = await createPendingAsset(getDb(), { workspaceId: s.workspaceId, ...b });
  return json({ asset: serializeAsset(a), uploadUrl: `/api/assets/${a.id}/content` }, 201);
});
