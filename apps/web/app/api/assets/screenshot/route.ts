import { z } from "zod";
import { enqueueJob, getDb } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { serializeJob } from "@/lib/server/serialize";

/**
 * Capture a public web page as an image asset (FR-15). Runs in an isolated worker browser whose
 * every request passes the same SSRF checks as URL import. Authenticated pages are not supported.
 */
export const POST = route(async (req) => {
  const s = await requireSession();
  const b = await body(req, z.object({ url: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), "Only http(s) pages can be captured."), width: z.number().int().min(320).max(2560).default(1440), height: z.number().int().min(320).max(2560).default(900), fullPage: z.boolean().default(false) }));
  const idem = idempotencyKey(req);
  const { job } = await enqueueJob(getDb(), { workspaceId: s.workspaceId, type: "screenshot_capture", input: b, idempotencyKey: idem ? `shot:${idem}` : null, maxAttempts: 2 });
  return json({ job: serializeJob(job) }, 202);
});
