import "server-only";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { AppError, createPendingAsset, enqueueJob, getCollection, getDb, getStore, newId, schema, type SessionInfo } from "@vs/db";
import { serializeAsset } from "./serialize";
import { capabilityChecks } from "./templates";

/** Speech-to-text availability and the operator-configured price used for estimates. */
export async function sttOptions(workspaceId: string) {
  const { check } = await capabilityChecks(workspaceId);
  const price = process.env.STT_PRICE_USD_PER_HOUR;
  return { sttAvailable: check.transcription!(), sttPricePerHourMicros: price ? Math.round(Number(price) * 1_000_000) : null };
}

export async function collectionView(id: string, workspaceId: string) {
  const db = getDb();
  const { collection, limits, items, totals } = await getCollection(db, id, workspaceId);
  const assetIds = items.map((i) => i.assetId).filter((x): x is string => !!x);
  const assets = assetIds.length ? await db.query.assets.findMany({ where: and(inArray(schema.assets.id, assetIds), eq(schema.assets.workspaceId, workspaceId)) }) : [];
  const byId = new Map(assets.map((a) => [a.id, serializeAsset(a)]));
  const itemJobs = items.length
    ? await db.query.jobs.findMany({ where: and(eq(schema.jobs.workspaceId, workspaceId), inArray(schema.jobs.type, ["collection_ingest", "ingest_asset"])), orderBy: (j, { desc }) => desc(j.createdAt), limit: 500 })
    : [];
  return {
    collection: { id: collection.id, name: collection.name, createdAt: collection.createdAt },
    limits,
    totals,
    importRoot: importRootEnabled(),
    stt: await sttOptions(workspaceId),
    items: items.map((i) => {
      const job = itemJobs.find((j) => (j.type === "collection_ingest" && (j.input as { itemId?: string }).itemId === i.id) || (j.type === "ingest_asset" && (j.input as { assetId?: string }).assetId === i.assetId));
      return { ...i, asset: i.assetId ? (byId.get(i.assetId) ?? null) : null, job: job ? { id: job.id, type: job.type, status: job.status, stage: job.stage, error: job.error } : null };
    }),
  };
}

// ---- Operator-configured, read-only server import root (FR-16) ----
// A browser can only pick paths *inside* COLLECTION_IMPORT_ROOT, only when the operator set
// it, and only as an owner. Paths are resolved with realpath so symlinks can't escape.

const MEDIA_EXT = new Set([".mp4", ".mov", ".webm", ".m4a", ".mp3", ".wav", ".srt", ".vtt"]);

export function importRootEnabled() {
  return !!process.env.COLLECTION_IMPORT_ROOT;
}

async function rootDir() {
  const r = process.env.COLLECTION_IMPORT_ROOT;
  if (!r) throw new AppError(404, "import_root_disabled", "Server import is not configured.", "An operator can set COLLECTION_IMPORT_ROOT to a read-only folder.");
  return realpath(r);
}

function requireOwner(s: SessionInfo) {
  if (s.role !== "owner") throw new AppError(403, "forbidden", "Only workspace owners can import from the server.");
}

async function resolveInside(rel: string) {
  const root = await rootDir();
  if (rel.includes("\0") || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) throw new AppError(400, "invalid_path", "Paths are relative to the import folder.");
  const full = await realpath(join(root, rel)).catch(() => null);
  if (!full || (full !== root && !full.startsWith(root + sep))) throw new AppError(404, "not_found", "That path is not inside the import folder.");
  return { root, full };
}

export async function listServerFiles(s: SessionInfo, rel: string) {
  requireOwner(s);
  const { root, full } = await resolveInside(rel || ".");
  const entries = await readdir(full, { withFileTypes: true });
  const out: { path: string; name: string; type: "dir" | "file"; bytes?: number }[] = [];
  for (const e of entries.slice(0, 2000)) {
    if (e.name.startsWith(".")) continue;
    const p = join(full, e.name);
    const l = await lstat(p);
    if (l.isSymbolicLink()) continue; // never follow links out of the root
    if (l.isDirectory()) out.push({ path: relative(root, p), name: e.name, type: "dir" });
    else if (l.isFile() && MEDIA_EXT.has(extname(e.name).toLowerCase())) out.push({ path: relative(root, p), name: e.name, type: "file", bytes: l.size });
  }
  return { path: relative(root, full), entries: out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1)) };
}

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".srt": "application/x-subrip", ".vtt": "text/vtt" };

/** Copy selected server files into storage as collection items (skips ones already imported). */
export async function importServerFiles(s: SessionInfo, collectionId: string, paths: string[]) {
  requireOwner(s);
  const db = getDb();
  const { limits, items, totals } = await getCollection(db, collectionId, s.workspaceId);
  let bytes = totals.bytes;
  let count = items.filter((i) => i.status !== "failed").length;
  const results: { path: string; itemId?: string; status: "imported" | "skipped" | "rejected"; reason?: string }[] = [];
  for (const rel of paths) {
    const { full } = await resolveInside(rel);
    const st = await stat(full);
    const ext = extname(full).toLowerCase();
    if (!st.isFile() || !MEDIA_EXT.has(ext)) {
      results.push({ path: rel, status: "rejected", reason: "not a supported media file" });
      continue;
    }
    if (items.some((i) => i.sourceName === rel && Number(i.bytes) === st.size && i.status !== "failed")) {
      results.push({ path: rel, status: "skipped", reason: "already in this collection" });
      continue;
    }
    if (st.size > limits.maxFileBytes) {
      results.push({ path: rel, status: "rejected", reason: "exceeds the per-file limit" });
      continue;
    }
    if (bytes + st.size > limits.maxTotalBytes || count + 1 > limits.maxFiles) {
      results.push({ path: rel, status: "rejected", reason: "collection limit reached" });
      continue;
    }
    const asset = await createPendingAsset(db, { workspaceId: s.workspaceId, filename: rel.split("/").pop()!, mime: MIME[ext]!, bytes: st.size, rightsAcknowledged: true, provenance: { source: "server-import", collectionId, collectionMaxFileBytes: limits.maxFileBytes, relativePath: rel }, maxBytes: limits.maxFileBytes });
    await getStore().putStream(asset.storageKey, createReadStream(full), asset.mime ?? undefined);
    const [item] = await db.insert(schema.collectionItems).values({ id: newId("itm"), collectionId, workspaceId: s.workspaceId, assetId: asset.id, sourceName: rel.slice(-200), bytes: st.size, status: "pending" }).returning();
    await enqueueJob(db, { workspaceId: s.workspaceId, type: "ingest_asset", input: { assetId: asset.id }, idempotencyKey: `ingest:${asset.id}` });
    bytes += st.size;
    count++;
    results.push({ path: rel, itemId: item!.id, status: "imported" });
  }
  return results;
}
