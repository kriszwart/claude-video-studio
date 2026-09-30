import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

/** Package a rendered revision as an OpenTimelineIO bundle (.otioz) for editing elsewhere. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ revisionId: z.string().max(64).optional() }));
  const r = await enqueueProjectJob(s, id, "export_otio", b.revisionId, {}, idempotencyKey(req));
  return json(r, 202);
});
