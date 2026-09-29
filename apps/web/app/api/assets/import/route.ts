import { z } from "zod";
import { enqueueJob, getDb } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { serializeJob } from "@/lib/server/serialize";

/** Import an image/video/audio file from a public link (SSRF-guarded in the worker). */
export const POST = route(async (req) => {
  const s = await requireSession();
  const b = await body(req, z.object({ url: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), "Only http and https links can be imported."), rightsAcknowledged: z.literal(true), license: z.string().max(200).optional() }));
  const idem = idempotencyKey(req);
  const { job } = await getDb().transaction((tx) => enqueueJob(tx, { workspaceId: s.workspaceId, projectId: null, revisionId: null, type: "import_url", input: b, idempotencyKey: idem ? `import:${idem}` : null }));
  return json({ job: serializeJob(job) }, 202);
});
