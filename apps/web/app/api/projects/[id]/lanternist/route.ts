import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

/** Send this project's shot plan to Lanternist (optionally with a review link and Lanternist-drawn pictures). */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ reviewLink: z.boolean().default(true), pictures: z.boolean().default(false) }));
  const r = await enqueueProjectJob(s, id, "send_lanternist", undefined, b, idempotencyKey(req));
  return json(r, 202);
});
