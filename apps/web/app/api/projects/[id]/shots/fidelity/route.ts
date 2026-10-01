import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

/**
 * Ask Claude to compare generated takes with their shot's reference photos (shape, logo, label,
 * colour, proportions). Default: every take not yet checked; or one take, or chosen shots.
 */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ sceneIds: z.array(z.string().max(64)).max(50).optional(), assetId: z.string().max(64).optional(), recheck: z.boolean().optional(), effort: z.enum(["medium", "high", "max"]).optional() }));
  const r = await enqueueProjectJob(s, id, "check_fidelity", undefined, b, idempotencyKey(req), { requiresClaude: true });
  return json(r, 202);
});
