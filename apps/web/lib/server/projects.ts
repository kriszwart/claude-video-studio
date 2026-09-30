import "server-only";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { getDb, getProject, keyframeHash, listRevisions, schema, type DbOrTx } from "@vs/db";
import type { RevisionHistoryMeta } from "@vs/domain";
import { serializeExport, serializeJob } from "./serialize";
import { signAssetUrl } from "@vs/db";

export async function projectView(projectId: string, workspaceId: string, db: DbOrTx = getDb()) {
  const { project, revision, doc } = await getProject(db, projectId, workspaceId);
  const exports = await db.query.exportsTable.findMany({ where: eq(schema.exportsTable.projectId, projectId), orderBy: desc(schema.exportsTable.createdAt), limit: 30 });
  // Live-preview builds (one per edit) are the player's business; keep them out of the job list
  // so they never crowd out keyframes, narration or render jobs.
  const jobs = await db.query.jobs.findMany({ where: and(eq(schema.jobs.projectId, projectId), ne(schema.jobs.type, "live_preview")), orderBy: desc(schema.jobs.createdAt), limit: 40 });
  // Latest successful keyframes per scene (any revision; the client flags staleness by scene hash).
  const kfJobs = jobs.filter((j) => j.type === "keyframes" && j.status === "succeeded");
  const keyframes: Record<string, { url: string; revisionId: string; fresh: boolean }> = {};
  for (const j of kfJobs.reverse()) {
    const r = j.result as { keyframes?: { sceneId: string; assetId: string; sceneHash?: string }[] } | null;
    for (const k of r?.keyframes ?? []) {
      if (!doc.scenes.some((s) => s.id === k.sceneId)) continue;
      keyframes[k.sceneId] = { url: signAssetUrl(k.assetId, workspaceId), revisionId: j.revisionId!, fresh: k.sceneHash === keyframeHash(doc, k.sceneId) };
    }
  }
  // Audio media for the timeline: probed durations and waveform peaks (no URLs needed).
  const audioIds = [...new Set(doc.audio.map((t) => t.assetId))];
  const audioRows = audioIds.length ? await db.query.assets.findMany({ where: and(eq(schema.assets.workspaceId, workspaceId), inArray(schema.assets.id, audioIds)) }) : [];
  const media: Record<string, { durationSec: number | null; peaks: number[] | null; name: string }> = {};
  for (const a of audioRows) media[a.id] = { durationSec: (a.media as { durationSec?: number }).durationSec ?? null, peaks: (a.derived as { peaks?: number[] }).peaks ?? null, name: a.originalName };
  const history = revision.history as RevisionHistoryMeta;
  return {
    project: {
      id: project.id,
      title: project.title,
      status: project.status,
      isSample: project.isSample,
      family: project.family,
      templateId: project.templateId,
      templateVersion: project.templateVersion,
      variantGroupId: project.variantGroupId,
      variantLabel: project.variantLabel,
      budget: project.budget,
      updatedAt: project.updatedAt,
    },
    revision: { id: revision.id, seq: revision.seq, author: revision.author, action: revision.action, createdAt: revision.createdAt, documentHash: revision.documentHash },
    doc,
    canUndo: history.undoStack.length > 0,
    canRedo: history.redoStack.length > 0,
    exports: exports.map(serializeExport),
    jobs: jobs.map(serializeJob),
    keyframes,
    media,
    revisions: await listRevisions(db, projectId, 30),
  };
}
export type ProjectView = Awaited<ReturnType<typeof projectView>>;

export async function referencedAssets(workspaceId: string, ids: string[]) {
  if (!ids.length) return [];
  return getDb().query.assets.findMany({ where: and(eq(schema.assets.workspaceId, workspaceId), inArray(schema.assets.id, ids)) });
}
