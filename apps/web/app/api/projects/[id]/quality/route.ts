import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, getProject, schema } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

export const dynamic = "force-dynamic";

/** Quality reports for this project, newest first (revision, samples, evidence, issues, repairs). */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const db = getDb();
  await getProject(db, id, s.workspaceId);
  const reports = await db.query.qualityReports.findMany({ where: and(eq(schema.qualityReports.projectId, id), eq(schema.qualityReports.workspaceId, s.workspaceId)), orderBy: desc(schema.qualityReports.createdAt), limit: 10 });
  return json({ reports });
});

/** Start a bounded review–repair run on the current revision (default two repair passes). */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ revisionId: z.string().max(64).optional(), maxRepairPasses: z.number().int().min(0).max(5).default(2), maxJobSec: z.number().int().min(30).max(3600).default(900) }));
  const r = await enqueueProjectJob(s, id, "quality_review", b.revisionId, { maxRepairPasses: b.maxRepairPasses, maxJobSec: b.maxJobSec }, idempotencyKey(req));
  return json(r, 202);
});
