import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

/** Analyse the project's music and propose (unverified) beat/section markers. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ trackId: z.string().max(64).optional(), density: z.enum(["sections", "downbeats", "beats"]).default("downbeats") }));
  const r = await enqueueProjectJob(s, id, "analyze_music", undefined, b, idempotencyKey(req));
  return json(r, 202);
});
