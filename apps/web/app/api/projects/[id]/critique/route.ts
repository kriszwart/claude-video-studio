import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, getProject, schema, signAssetUrl } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

export const dynamic = "force-dynamic";

/** Claude's visual critiques of this project, newest first, with signed evidence-frame URLs. */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const db = getDb();
  await getProject(db, id, s.workspaceId);
  const rows = await db.query.critiques.findMany({ where: and(eq(schema.critiques.projectId, id), eq(schema.critiques.workspaceId, s.workspaceId)), orderBy: desc(schema.critiques.createdAt), limit: 10 });
  const critiques = rows.map((r) => {
    const report = r.report as { frames: { assetId: string }[] };
    return { id: r.id, revisionId: r.revisionId, createdAt: r.createdAt, report: { ...report, frames: report.frames.map((f) => ({ ...f, url: signAssetUrl(f.assetId, s.workspaceId) })) } };
  });
  return json({ critiques });
});

/** Ask Claude to critique a revision (default: the current one). Read-only until a finding is applied. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ revisionId: z.string().max(64).optional(), focus: z.string().trim().max(500).optional(), effort: z.enum(["medium", "high", "max"]).optional() }));
  const r = await enqueueProjectJob(s, id, "critique", b.revisionId, { ...(b.focus ? { focus: b.focus } : {}), ...(b.effort ? { effort: b.effort } : {}) }, idempotencyKey(req), { requiresClaude: true });
  return json(r, 202);
});
