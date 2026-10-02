import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

/** Have Claude plan a screen demo's steps on its real screenshot. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ sceneId: z.string().max(64) }));
  const r = await enqueueProjectJob(s, id, "plan_demo", undefined, b, idempotencyKey(req), { requiresClaude: true });
  return json(r, 202);
});
