import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(
    req,
    z.object({
      baseRevisionId: z.string().max(64),
      targetDurationSec: z.number().positive().max(600).optional(),
      assetIds: z.array(z.string().max(64)).max(50).optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      narration: z.object({ voiceId: z.string().min(1).max(120) }).optional(),
      /** Hold the result for shot-plan review (composer flows). */
      review: z.boolean().optional(),
      /** Owner's note when replanning. */
      note: z.string().max(1000).optional(),
    }),
  );
  const r = await enqueueProjectJob(s, id, "plan", b.baseRevisionId, { baseRevisionId: b.baseRevisionId, targetDurationSec: b.targetDurationSec, assetIds: b.assetIds, effort: b.effort, narration: b.narration, review: b.review, note: b.note }, idempotencyKey(req), { requiresClaude: true });
  return json(r, 202);
});
