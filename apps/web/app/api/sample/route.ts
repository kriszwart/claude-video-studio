import { enqueueJob, getDb } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";
import { serializeJob } from "@/lib/server/serialize";

/** Create the labelled sample product-launch project (idempotent per workspace). */
export const POST = route(async () => {
  const s = await requireSession();
  const { job } = await enqueueJob(getDb(), { workspaceId: s.workspaceId, type: "seed_sample", input: {}, idempotencyKey: "seed-sample" });
  return json({ job: serializeJob(job) }, 202);
});
