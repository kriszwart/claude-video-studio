import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

/** Lock the video to its music: the drop on the payoff, cuts on beats. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ trackId: z.string().max(64).optional(), payoffSceneId: z.string().max(64).optional() }));
  const r = await enqueueProjectJob(s, id, "lock_music", undefined, b, idempotencyKey(req));
  return json(r, 202);
});
