import { requireSession } from "@/lib/server/auth";
import { idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

/**
 * Find background footage for every scene (Claude writes the searches when it is on). The job's
 * result lists ranked candidates per scene; nothing is imported until the owner picks one.
 */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  return json(await enqueueProjectJob(s, id, "match_footage", undefined, {}, idempotencyKey(req), { maxAttempts: 1 }), 202);
});
