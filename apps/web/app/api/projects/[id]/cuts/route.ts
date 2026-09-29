import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

/** Propose silence/filler/retake cuts for review (never applied without acceptance or an authorised policy). */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ silenceDb: z.number().min(-70).max(-20).default(-38), minSilenceSec: z.number().min(0.2).max(10).default(0.5) }));
  const r = await enqueueProjectJob(s, id, "propose_cuts", undefined, b, idempotencyKey(req));
  return json(r, 202);
});
