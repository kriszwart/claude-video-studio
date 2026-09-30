import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { dataDir, getDb, getStore, schema } from "@vs/db";

let lastLivePrune = 0;

/**
 * Live-preview bundles are disposable caches (rebuilt on demand in seconds): drop bundles not
 * built/used for LIVE_TTL_HOURS (default 48), cached mixes after 7 days, and abandoned temp dirs.
 */
export async function pruneLiveBundles(now = Date.now()): Promise<number> {
  const root = join(dataDir(), "live");
  const ttl = Number(process.env.LIVE_TTL_HOURS ?? 48) * 3600_000;
  let removed = 0;
  const entries = await readdir(root).catch(() => [] as string[]);
  for (const name of entries) {
    const p = join(root, name);
    const st = await stat(p).catch(() => null);
    if (!st) continue;
    const age = now - st.mtimeMs;
    if (name === "mix") {
      for (const f of await readdir(p).catch(() => [] as string[])) {
        const fs = await stat(join(p, f)).catch(() => null);
        if (fs && now - fs.mtimeMs > 7 * 24 * 3600_000) {
          await rm(join(p, f), { force: true });
          removed++;
        }
      }
    } else if ((name.includes(".tmp-") && age > 3600_000) || (!name.includes(".tmp-") && age > ttl)) {
      await rm(p, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * Purge projects past their recovery window. Assets referenced by any other project or
 * template are preserved; failures are retried and visible to the operator.
 */
export async function runCleanup(): Promise<{ purged: number; failed: number }> {
  if (Date.now() - lastLivePrune > 30 * 60_000) {
    lastLivePrune = Date.now();
    await pruneLiveBundles().catch(() => 0);
  }
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
