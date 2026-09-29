import { z } from "zod";
import { AspectRatio } from "@vs/domain";
import { enqueueJob, getCollection, getDb } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { serializeJob } from "@/lib/server/serialize";

/** Build a P3 Event Sizzle project from selected quotes (async: cut points are measured). */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(
    req,
    z.object({
      title: z.string().min(1).max(160),
      aspect: AspectRatio.optional(),
      brandKitId: z.string().max(64).optional(),
      inputs: z.object({ eventName: z.string().min(1).max(60), invitation: z.array(z.string().min(1).max(200)).max(3).default([]), cta: z.string().max(50).optional(), logo: z.string().max(64).optional(), music: z.string().max(64).optional() }),
      quotes: z.array(z.object({ transcriptId: z.string().max(64), segmentIds: z.array(z.string().max(40)).min(1).max(40), theme: z.string().max(40).default(""), speaker: z.string().max(80).optional() })).min(1).max(24),
    }),
  );
  const db = getDb();
  await getCollection(db, id, s.workspaceId);
  const idem = idempotencyKey(req);
  const { job, created } = await enqueueJob(db, { workspaceId: s.workspaceId, type: "build_sizzle", input: { collectionId: id, ...b }, idempotencyKey: idem ? `sizzle:${idem}` : null });
  return json({ job: serializeJob(job), created }, 202);
});
