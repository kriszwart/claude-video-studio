import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

/** Place sound effects from the sound kit (replacing effects placed before). */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ density: z.enum(["minimal", "moderate", "rich"]).optional() }));
  const r = await enqueueProjectJob(s, id, "place_sfx", undefined, b, idempotencyKey(req));
  return json(r, 202);
});
