import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ baseRevisionId: z.string().max(64), targetDurationSec: z.number().positive().max(300).optional(), assetIds: z.array(z.string().max(64)).max(50).optional() }));
  const r = await enqueueProjectJob(s, id, "plan", b.baseRevisionId, { baseRevisionId: b.baseRevisionId, targetDurationSec: b.targetDurationSec, assetIds: b.assetIds }, idempotencyKey(req), { requiresClaude: true });
  return json(r, 202);
});
