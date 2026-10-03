import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { getDb, getProject, schema } from "@vs/db";
import { AspectRatio, exportSizes, ProjectDocument } from "@vs/domain";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";
import { serializeExport } from "@/lib/server/serialize";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  await getProject(getDb(), id, s.workspaceId);
  const rows = await getDb().query.exportsTable.findMany({ where: eq(schema.exportsTable.projectId, id), orderBy: desc(schema.exportsTable.createdAt) });
  return json({ exports: rows.map(serializeExport) });
});

/**
 * Export the final MP4, optionally in several sizes at once (e.g. 16:9, 9:16 and 1:1). Each extra
 * size is its own export job rendering the same revision with that aspect; the project itself is
 * not changed, and layouts adapt to each size as they do in the editor.
 */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ revisionId: z.string().max(64).optional(), aspects: z.array(AspectRatio).max(3).optional(), resolution: z.enum(["1080p", "4k"]).default("1080p") }));
  // 4K renders the same composition at twice the scale (3840×2160 for 16:9).
  const res = b.resolution === "4k" ? { resolution: "4k" } : {};
  if (!b.aspects?.length) return json(await enqueueProjectJob(s, id, "export", b.revisionId, res, idempotencyKey(req)), 202);
  const { doc } = await getProject(getDb(), id, s.workspaceId);
  const own = ProjectDocument.parse(doc).format.aspect;
  const idem = idempotencyKey(req);
  const results = [];
  for (const aspect of exportSizes(own, b.aspects)) {
    results.push(await enqueueProjectJob(s, id, "export", b.revisionId, aspect === own ? { ...res } : { aspect, ...res }, idem ? `${idem}:${aspect}${b.resolution === "4k" ? ":4k" : ""}` : null));
  }
  return json({ ...results[0]!, jobs: results.map((r) => r.job) }, 202);
});
