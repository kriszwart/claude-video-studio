import { z } from "zod";
import { SCRIPT_STYLE_IDS } from "@vs/domain";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

/** Write the script (or rewrite it with a note). The result is a draft for the owner to approve. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(
    req,
    z.object({
      style: z.enum(SCRIPT_STYLE_IDS).optional(),
      direction: z.string().max(400).optional(),
      narrated: z.boolean().optional(),
      note: z.string().max(1000).optional(),
      targetDurationSec: z.number().min(5).max(600).optional(),
    }),
  );
  const r = await enqueueProjectJob(s, id, "write_script", undefined, b, idempotencyKey(req), { requiresClaude: true });
  return json(r, 202);
});
