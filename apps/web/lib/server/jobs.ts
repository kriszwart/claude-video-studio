import "server-only";
import { AppError, enqueueJob, getDb, getProject, getProviderSecret, getRevision, routingStatus, schema, type JobType } from "@vs/db";
import type { SessionInfo } from "@vs/db";
import { serializeJob } from "./serialize";

/** Enqueue async work pinned to an immutable revision of an owned project; returns 202. */
export async function enqueueProjectJob(
  s: SessionInfo,
  projectId: string,
  type: JobType,
  revisionId: string | undefined,
  input: Record<string, unknown>,
  idem: string | null,
  opts: { requiresClaude?: boolean } = {},
) {
  const db = getDb();
  const { project } = await getProject(db, projectId, s.workspaceId);
  if (project.status !== "active") throw new AppError(409, "project_inactive", "Restore this project before starting new work.");
  const rev = await getRevision(db, projectId, revisionId ?? project.currentRevisionId!);
  if (opts.requiresClaude && !(await getProviderSecret(db, s.workspaceId, "anthropic"))) {
    throw new AppError(412, "credentials_missing", "Claude is not configured, so this AI action is unavailable.", "Add an Anthropic API key in Settings → Providers. Manual editing and rendering keep working.");
  }
  const { job, created } = await db.transaction(async (tx) => {
    const r = await enqueueJob(tx, { workspaceId: s.workspaceId, projectId, revisionId: rev.id, type, input, idempotencyKey: idem ? `${type}:${idem}` : null });
    if (r.created) await tx.insert(schema.analyticsEvents).values({ workspaceId: s.workspaceId, name: `${type}_requested`, props: { projectId } });
    return r;
  });
  const requires = ((job.input as { requires?: string[] }).requires ?? []);
  return { job: serializeJob(job), created, routing: { requires, ...(await routingStatus(db, requires)) } };
}
