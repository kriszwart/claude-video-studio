import { createHash } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  applyOperations,
  referencedAssetIds,
  checkCreativeMode,
  computeTimeline,
  DEFAULT_BUDGET,
  DOCUMENT_SCHEMA_VERSION,
  historyForEdit,
  historyForRedo,
  historyForUndo,
  initialHistory,
  OperationError,
  ProjectDocument,
  stableStringify,
  type Actor,
  type BudgetPolicy,
  type Operation,
  type RevisionHistoryMeta,
} from "@vs/domain";
import type { DbOrTx } from "../client";
import { AppError, conflict, notFound } from "../errors";
import { newId } from "../ids";
import { assets, cleanupTasks, jobs, projectRevisions, projects } from "../schema";
import { emitJobEvent, requestCancel } from "./jobs";
import { deriveProgramState, touchesProgram } from "./transcripts";

export type ProjectRow = typeof projects.$inferSelect;
export type RevisionRow = typeof projectRevisions.$inferSelect;

export function hashDocument(doc: ProjectDocument): string {
  return createHash("sha256").update(stableStringify(doc)).digest("hex");
}

export function sceneHashes(doc: ProjectDocument): Record<string, string> {
  return Object.fromEntries(doc.scenes.map((s) => [s.id, createHash("sha256").update(stableStringify(s)).digest("hex").slice(0, 16)]));
}

export interface CreateProjectInput {
  workspaceId: string;
  doc: ProjectDocument;
  templateId: string;
  templateVersion: number;
  family: string;
  isSample?: boolean;
  budget?: BudgetPolicy;
  variantGroupId?: string;
  variantLabel?: string;
  author?: RevisionRow["author"];
  action?: string;
}

export async function createProject(db: DbOrTx, input: CreateProjectInput): Promise<{ project: ProjectRow; revision: RevisionRow }> {
  const doc = ProjectDocument.parse(input.doc);
  const projectId = newId("prj");
  const revisionId = newId("rev");
  const [project] = await db
    .insert(projects)
    .values({
      id: projectId,
      workspaceId: input.workspaceId,
      title: doc.title,
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      family: input.family,
      currentRevisionId: revisionId,
      isSample: input.isSample ?? false,
      budget: input.budget ?? DEFAULT_BUDGET,
      variantGroupId: input.variantGroupId,
      variantLabel: input.variantLabel,
    })
    .returning();
  const [revision] = await db
    .insert(projectRevisions)
    .values({
      id: revisionId,
      projectId,
      seq: 1,
      parentRevisionId: null,
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      document: doc,
      documentHash: hashDocument(doc),
      author: input.author ?? "system",
      action: input.action ?? "create",
      history: initialHistory(revisionId),
    })
    .returning();
  return { project: project!, revision: revision! };
}

export async function getProject(db: DbOrTx, projectId: string, workspaceId: string, opts: { includeDeleted?: boolean } = {}) {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), opts.includeDeleted ? undefined : ne(projects.status, "deleted")),
  });
  if (!project) throw notFound("Project");
  const revision = await db.query.projectRevisions.findFirst({ where: eq(projectRevisions.id, project.currentRevisionId!) });
  if (!revision) throw new AppError(500, "missing_revision", "The project's current revision is missing.");
  return { project, revision, doc: ProjectDocument.parse(revision.document) };
}

export async function getRevision(db: DbOrTx, projectId: string, revisionId: string) {
  const r = await db.query.projectRevisions.findFirst({ where: and(eq(projectRevisions.id, revisionId), eq(projectRevisions.projectId, projectId)) });
  if (!r) throw notFound("Revision");
  return r;
}

async function lockProject(db: DbOrTx, projectId: string, workspaceId: string) {
  const rows = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), ne(projects.status, "deleted"))).for("update");
  const project = rows[0];
  if (!project) throw notFound("Project");
  if (project.status === "archived") throw new AppError(409, "archived", "This project is archived. Restore it before editing.");
  return project;
}

async function insertRevision(
  db: DbOrTx,
  project: ProjectRow,
  current: RevisionRow,
  doc: ProjectDocument,
  meta: { author: RevisionRow["author"]; action: string; ops: unknown[]; history: (newId: string) => RevisionHistoryMeta },
) {
  const id = newId("rev");
  const [revision] = await db
    .insert(projectRevisions)
    .values({
      id,
      projectId: project.id,
      seq: current.seq + 1,
      parentRevisionId: current.id,
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      document: doc,
      documentHash: hashDocument(doc),
      author: meta.author,
      action: meta.action,
      operations: meta.ops,
      history: meta.history(id),
    })
    .returning();
  await db.update(projects).set({ currentRevisionId: id, title: doc.title, updatedAt: sql`now()` }).where(eq(projects.id, project.id));
  return revision!;
}

export interface ApplyInput {
  projectId: string;
  workspaceId: string;
  baseRevisionId: string;
  ops: Operation[];
  actor: Actor;
  author?: RevisionRow["author"];
  action?: string;
}

/**
 * Apply typed operations against an explicit base revision. A stale base returns 409
 * (FR-07/A10): nothing overwrites newer edits.
 */
export async function applyProjectOperations(db: DbOrTx, input: ApplyInput) {
  const project = await lockProject(db, input.projectId, input.workspaceId);
  if (project.currentRevisionId !== input.baseRevisionId) {
    throw conflict("The project changed since this edit was prepared.", { currentRevisionId: project.currentRevisionId });
  }
  const current = await db.query.projectRevisions.findFirst({ where: eq(projectRevisions.id, project.currentRevisionId!) });
  const doc = ProjectDocument.parse(current!.document);
  let result;
  try {
    result = applyOperations(doc, input.ops, input.actor);
  } catch (e) {
    if (e instanceof OperationError) throw new AppError(e.code === "locked" || e.code === "approved_claim" || e.code === "strict_mode" ? 403 : 422, e.code, e.message, undefined, e.details);
    throw e;
  }
  if (touchesProgram(input.ops)) {
    result.doc = ProjectDocument.parse(await deriveProgramState(db, result.doc, input.workspaceId, { regenerateCaptions: input.ops.some((o) => o.op === "correctTranscript" || o.op === "setProgram") }));
    // Beat output frames are only known after resolution: re-check A24 limits with them.
    if (input.actor === "assistant") {
      try {
        checkCreativeMode(doc, result.doc);
      } catch (e) {
        if (e instanceof OperationError) throw new AppError(e.code === "strict_mode" || e.code === "locked" || e.code === "approved_claim" ? 403 : 422, e.code, e.message);
        throw e;
      }
    }
  }
  // Any asset newly referenced by this edit must belong to this workspace (A14).
  const before = new Set(referencedAssetIds(doc));
  const added = referencedAssetIds(result.doc).filter((id) => !before.has(id));
  if (added.length) {
    const owned = await db.query.assets.findMany({ where: and(inArray(assets.id, added), eq(assets.workspaceId, input.workspaceId)), columns: { id: true } });
    if (owned.length !== added.length) throw new AppError(422, "unknown_asset", "An asset used in this edit is not available in this workspace.");
  }
  if (hashDocument(result.doc) === current!.documentHash) {
    return { revision: current!, doc: result.doc, changedSceneIds: [], noop: true };
  }
  const revision = await insertRevision(db, project, current!, result.doc, {
    author: input.author ?? (input.actor === "assistant" ? "assistant" : input.actor === "bulk" ? "bulk" : input.actor === "system" ? "system" : "user"),
    action: input.action ?? describeOps(input.ops),
    ops: input.ops,
    history: (id) => historyForEdit(current!.history as RevisionHistoryMeta, id),
  });
  return { revision, doc: result.doc, changedSceneIds: result.changedSceneIds, noop: false };
}

export function describeOps(ops: Operation[]): string {
  if (ops.length === 1) return ops[0]!.op;
  const kinds = [...new Set(ops.map((o) => o.op))];
  return kinds.length === 1 ? `${kinds[0]} ×${ops.length}` : `${ops.length} edits`;
}

/** Replace the whole document (planner output, variant creation). Still revisioned and base-checked. */
export async function replaceDocument(
  db: DbOrTx,
  input: { projectId: string; workspaceId: string; baseRevisionId: string; doc: ProjectDocument; author: RevisionRow["author"]; action: string },
) {
  const project = await lockProject(db, input.projectId, input.workspaceId);
  if (project.currentRevisionId !== input.baseRevisionId) throw conflict("The project changed while this was being prepared.", { currentRevisionId: project.currentRevisionId });
  const current = await db.query.projectRevisions.findFirst({ where: eq(projectRevisions.id, project.currentRevisionId!) });
  const doc = ProjectDocument.parse(input.doc);
  return insertRevision(db, project, current!, doc, {
    author: input.author,
    action: input.action,
    ops: [],
    history: (id) => historyForEdit(current!.history as RevisionHistoryMeta, id),
  });
}

export async function undoRedo(db: DbOrTx, input: { projectId: string; workspaceId: string; baseRevisionId: string; direction: "undo" | "redo" }) {
  const project = await lockProject(db, input.projectId, input.workspaceId);
  if (project.currentRevisionId !== input.baseRevisionId) throw conflict("The project changed; reload before undoing.", { currentRevisionId: project.currentRevisionId });
  const current = await db.query.projectRevisions.findFirst({ where: eq(projectRevisions.id, project.currentRevisionId!) });
  const h = current!.history as RevisionHistoryMeta;
  const step = input.direction === "undo" ? historyForUndo(h) : historyForRedo(h);
  if (!step) throw new AppError(409, `nothing_to_${input.direction}`, `There is nothing to ${input.direction}.`);
  const target = await db.query.projectRevisions.findFirst({ where: and(eq(projectRevisions.id, step.target), eq(projectRevisions.projectId, input.projectId)) });
  if (!target) throw notFound("Revision");
  const doc = ProjectDocument.parse(target.document);
  const revision = await insertRevision(db, project, current!, doc, { author: "user", action: input.direction, ops: [], history: () => step.meta });
  return { revision, doc };
}

export async function listProjects(db: DbOrTx, workspaceId: string, status: "active" | "archived" = "active") {
  return db.query.projects.findMany({ where: and(eq(projects.workspaceId, workspaceId), eq(projects.status, status)), orderBy: desc(projects.updatedAt), limit: 200 });
}

export async function listRevisions(db: DbOrTx, projectId: string, limit = 50) {
  return db
    .select({ id: projectRevisions.id, seq: projectRevisions.seq, author: projectRevisions.author, action: projectRevisions.action, createdAt: projectRevisions.createdAt, documentHash: projectRevisions.documentHash })
    .from(projectRevisions)
    .where(eq(projectRevisions.projectId, projectId))
    .orderBy(desc(projectRevisions.seq))
    .limit(limit);
}

export async function setProjectStatus(db: DbOrTx, projectId: string, workspaceId: string, status: "active" | "archived") {
  const [row] = await db.update(projects).set({ status, updatedAt: sql`now()` }).where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), ne(projects.status, "deleted"))).returning();
  if (!row) throw notFound("Project");
  return row;
}

export async function duplicateProject(db: DbOrTx, projectId: string, workspaceId: string, title?: string) {
  const { project, doc } = await getProject(db, projectId, workspaceId);
  const copy = { ...doc, title: title ?? `${doc.title} (copy)` };
  return createProject(db, {
    workspaceId,
    doc: copy,
    templateId: project.templateId,
    templateVersion: project.templateVersion,
    family: project.family,
    budget: project.budget as BudgetPolicy,
    action: `duplicate of ${project.id}`,
  });
}

/**
 * FR-01 deletion: stop new work, request cancellation of active jobs, schedule purge of
 * exclusively-owned artifacts after a recovery period (default 7 days).
 */
export async function deleteProject(db: DbOrTx, projectId: string, workspaceId: string, recoveryDays = Number(process.env.DELETE_RECOVERY_DAYS ?? 7)) {
  const project = await lockProject(db, projectId, workspaceId).catch(async (e) => {
    if (e instanceof AppError && e.code === "archived") {
      return (await db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)) }))!;
    }
    throw e;
  });
  const purgeAfter = new Date(Date.now() + recoveryDays * 86400_000);
  await db.update(projects).set({ status: "deleted", deletedAt: sql`now()`, purgeAfter, updatedAt: sql`now()` }).where(eq(projects.id, project.id));
  const active = await db.query.jobs.findMany({ where: and(eq(jobs.projectId, projectId), inArray(jobs.status, ["queued", "running", "waiting_provider"])) });
  for (const j of active) await requestCancel(db, j);
  await db.insert(cleanupTasks).values({ workspaceId, kind: "purge_project", target: projectId, runAfter: purgeAfter });
  return { purgeAfter, canceledJobs: active.length };
}

export async function restoreDeletedProject(db: DbOrTx, projectId: string, workspaceId: string) {
  const [row] = await db
    .update(projects)
    .set({ status: "active", deletedAt: null, purgeAfter: null, updatedAt: sql`now()` })
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), eq(projects.status, "deleted"), sql`${projects.purgeAfter} > now()`))
    .returning();
  if (!row) throw new AppError(409, "not_restorable", "This project cannot be restored (it may already have been purged).");
  await db.update(cleanupTasks).set({ doneAt: sql`now()`, lastError: "restored" }).where(and(eq(cleanupTasks.target, projectId), eq(cleanupTasks.kind, "purge_project")));
  return row;
}

export { emitJobEvent };

/** Bumped when still capture changes (e.g. video frame injection) so cached keyframes refresh. */
const KEYFRAME_RENDER_VERSION = 2;

/** Everything that affects how one scene's keyframe looks. */
export function keyframeHash(doc: ProjectDocument, sceneId: string): string {
  const scene = doc.scenes.find((s) => s.id === sceneId);
  // Program projects: the presenter footage, captions and beats shown depend on the EDL and
  // on where the scene sits in the output, so those are part of the look too.
  const program = doc.program ? { edl: doc.program.edl, framing: doc.program.presenterFraming, start: computeTimeline(doc).scenes.find((s) => s.sceneId === sceneId)?.start, beats: doc.beats, captions: doc.captions } : null;
  return createHash("sha256").update(stableStringify({ v: KEYFRAME_RENDER_VERSION, scene, format: doc.format, brand: doc.brand, profile: doc.profile, program })).digest("hex").slice(0, 20);
}
