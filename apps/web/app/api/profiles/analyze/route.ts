import { z } from "zod";
import { enqueueJob, getAsset, getDb } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { serializeJob } from "@/lib/server/serialize";

/** Analyse a reference clip (or screenshot) into proposed traits with evidence. Saves nothing. */
export const POST = route(async (req) => {
  const s = await requireSession();
  const b = await body(req, z.object({ assetId: z.string().max(64) }));
  const db = getDb();
  await getAsset(db, b.assetId, s.workspaceId);
  const idem = idempotencyKey(req);
  const { job } = await enqueueJob(db, { workspaceId: s.workspaceId, type: "analyze_reference", input: { assetId: b.assetId }, idempotencyKey: idem ? `ref:${idem}` : null });
  return json({ job: serializeJob(job) }, 202);
});
