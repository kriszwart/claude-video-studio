import { z } from "zod";
import { enqueueIndexing, getDb, planIndexing } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";
import { sttOptions } from "@/lib/server/collections";

/**
 * Plan (dryRun) or start indexing. The plan shows, per item, whether it will reuse an
 * existing transcript (same content), import a sidecar subtitle, be transcribed (with the
 * estimated cost) or stay "needs transcript". Index a subset first; indexed items are never
 * indexed again.
 */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ itemIds: z.array(z.string().max(64)).max(2000).optional(), all: z.boolean().default(false), dryRun: z.boolean().default(false) }));
  const db = getDb();
  const plan = await planIndexing(db, s.workspaceId, id, b.all ? "all" : (b.itemIds ?? []), await sttOptions(s.workspaceId));
  if (b.dryRun) return json({ plan });
  const run = plan.items.filter((i) => i.action === "reuse" || i.action === "sidecar" || i.action === "transcribe" || i.action === "needs_transcript").map((i) => i.id);
  const jobs = await enqueueIndexing(db, s.workspaceId, id, run);
  return json({ plan, jobs }, 202);
});
