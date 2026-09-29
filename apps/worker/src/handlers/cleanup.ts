import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { getDb, getStore, schema } from "@vs/db";

/**
 * Purge projects past their recovery window. Assets referenced by any other project or
 * template are preserved; failures are retried and visible to the operator.
 */
export async function runCleanup(): Promise<{ purged: number; failed: number }> {
  const db = getDb();
  const due = await db.query.cleanupTasks.findMany({ where: and(isNull(schema.cleanupTasks.doneAt), lte(schema.cleanupTasks.runAfter, sql`now()`)), limit: 20 });
  let purged = 0;
  let failed = 0;
  for (const t of due) {
    try {
      if (t.kind === "purge_project") {
        const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, t.target) });
        if (project && project.status === "deleted") {
          const exports = await db.query.exportsTable.findMany({ where: eq(schema.exportsTable.projectId, project.id) });
          const renderAssetIds = exports.flatMap((e) => [e.videoAssetId, e.thumbnailAssetId, e.captionsSrtAssetId, e.captionsVttAssetId]).filter(Boolean) as string[];
          for (const id of renderAssetIds) {
            const a = await db.query.assets.findFirst({ where: eq(schema.assets.id, id) });
            if (a) {
              await getStore().delete(a.storageKey);
              await db.delete(schema.assets).where(eq(schema.assets.id, id));
            }
          }
          await db.delete(schema.exportsTable).where(eq(schema.exportsTable.projectId, project.id));
          await db.delete(schema.projectRevisions).where(eq(schema.projectRevisions.projectId, project.id));
          await db.update(schema.projects).set({ currentRevisionId: null }).where(eq(schema.projects.id, project.id));
          await db.delete(schema.projects).where(eq(schema.projects.id, project.id));
          // Uploaded source media stays in the workspace library (it may be reused elsewhere).
        }
      }
      await db.update(schema.cleanupTasks).set({ doneAt: sql`now()` }).where(eq(schema.cleanupTasks.id, t.id));
      purged++;
    } catch (e) {
      failed++;
      await db
        .update(schema.cleanupTasks)
        .set({ attempts: t.attempts + 1, lastError: e instanceof Error ? e.message : String(e), runAfter: sql`now() + interval '10 minutes'` })
        .where(eq(schema.cleanupTasks.id, t.id));
    }
  }
  return { purged, failed };
}
