import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DbOrTx } from "../client";
import { AppError, notFound } from "../errors";
import { newId } from "../ids";
import { assets, collectionItems, collections, jobs } from "../schema";
import { createPendingAsset } from "./assets";
import { enqueueJob } from "./jobs";

/**
 * Event collections (FR-16): recordings grouped independently of any project, indexed as
 * time-coded transcript segments for search. Limits are per file and per collection.
 */
export interface CollectionLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}
export const DEFAULT_COLLECTION_LIMITS: CollectionLimits = {
  maxFiles: Number(process.env.COLLECTION_MAX_FILES ?? 500),
  maxFileBytes: Number(process.env.COLLECTION_MAX_FILE_BYTES ?? 8 * 1024 ** 3),
  maxTotalBytes: Number(process.env.COLLECTION_MAX_TOTAL_BYTES ?? 200 * 1024 ** 3),
};

export async function createCollection(db: DbOrTx, workspaceId: string, name: string, limits: Partial<CollectionLimits> = {}) {
  const id = newId("col");
  const [row] = await db.insert(collections).values({ id, workspaceId, name, limits: { ...DEFAULT_COLLECTION_LIMITS, ...limits } }).returning();
  return row!;
}

export async function getCollection(db: DbOrTx, id: string, workspaceId: string) {
  const c = await db.query.collections.findFirst({ where: and(eq(collections.id, id), eq(collections.workspaceId, workspaceId)) });
  if (!c) throw notFound("Collection");
  const items = await db.query.collectionItems.findMany({ where: eq(collectionItems.collectionId, id), orderBy: [asc(collectionItems.createdAt)] });
  const limits = c.limits as CollectionLimits;
  const totals = {
    files: items.length,
    bytes: items.reduce((a, i) => a + Number(i.bytes ?? 0), 0),
    durationSec: items.reduce((a, i) => a + Number(i.durationSec ?? 0), 0),
    byStatus: items.reduce<Record<string, number>>((a, i) => ((a[i.status] = (a[i.status] ?? 0) + 1), a), {}),
    indexedDurationSec: items.filter((i) => i.status === "indexed").reduce((a, i) => a + Number(i.durationSec ?? 0), 0),
  };
  return { collection: c, limits, items, totals };
}

export async function listCollections(db: DbOrTx, workspaceId: string) {
  const rows = await db.query.collections.findMany({ where: eq(collections.workspaceId, workspaceId), orderBy: [desc(collections.createdAt)] });
  const counts = rows.length
    ? await db
        .select({ id: collectionItems.collectionId, files: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${collectionItems.bytes}),0)::bigint`, indexed: sql<number>`count(*) filter (where ${collectionItems.status} = 'indexed')::int`, durationSec: sql<number>`coalesce(sum(${collectionItems.durationSec}),0)::float` })
        .from(collectionItems)
        .where(inArray(collectionItems.collectionId, rows.map((r) => r.id)))
        .groupBy(collectionItems.collectionId)
    : [];
  return rows.map((r) => {
    const c = counts.find((x) => x.id === r.id);
    return { ...r, files: Number(c?.files ?? 0), bytes: Number(c?.bytes ?? 0), indexed: Number(c?.indexed ?? 0), durationSec: Number(c?.durationSec ?? 0) };
  });
}

/**
 * Reserve an upload into a collection (browser-selected files). Idempotent per file name
 * and size: re-selecting the same folder after an interruption returns the existing item
 * and its upload so completed files are skipped and partial ones resume (A20).
 */
export async function reserveCollectionUpload(db: DbOrTx, workspaceId: string, collectionId: string, input: { filename: string; mime: string; bytes: number; rightsAcknowledged: boolean; relativePath?: string }) {
  const { limits, items, totals } = await getCollection(db, collectionId, workspaceId);
  const sourceName = (input.relativePath || input.filename).slice(-200);
  const existing = items.find((i) => i.sourceName === sourceName && Number(i.bytes) === input.bytes && i.status !== "failed");
  if (existing) {
    const asset = existing.assetId ? await db.query.assets.findFirst({ where: eq(assets.id, existing.assetId) }) : null;
    return { item: existing, asset, created: false };
  }
  if (items.filter((i) => i.status !== "failed").length + 1 > limits.maxFiles) throw new AppError(413, "collection_limit", `This collection is limited to ${limits.maxFiles} files.`);
  if (input.bytes > limits.maxFileBytes) throw new AppError(413, "collection_limit", `“${sourceName}” exceeds the per-file limit of ${fmtBytes(limits.maxFileBytes)}.`);
  if (totals.bytes + input.bytes > limits.maxTotalBytes) throw new AppError(413, "collection_limit", `This file would exceed the collection's total limit of ${fmtBytes(limits.maxTotalBytes)}.`);
  const asset = await createPendingAsset(db, { workspaceId, filename: input.filename, mime: input.mime, bytes: input.bytes, rightsAcknowledged: input.rightsAcknowledged, provenance: { source: "collection-upload", collectionId, collectionMaxFileBytes: limits.maxFileBytes, relativePath: input.relativePath }, maxBytes: limits.maxFileBytes });
  const [item] = await db.insert(collectionItems).values({ id: newId("itm"), collectionId, workspaceId, assetId: asset.id, sourceName, bytes: input.bytes, status: "pending" }).returning();
  return { item: item!, asset, created: true };
}

/**
 * Called by asset ingest: reflect the probed/deduplicated/failed asset on its collection
 * items. Identical content already in the collection is not indexed twice.
 */
export async function syncCollectionItemsForAsset(db: DbOrTx, assetId: string) {
  const asset = await db.query.assets.findFirst({ where: eq(assets.id, assetId) });
  if (!asset) return;
  const items = await db.query.collectionItems.findMany({ where: eq(collectionItems.assetId, assetId) });
  for (const item of items) {
    if (asset.status === "failed") {
      const dupOf = (asset.provenance as { duplicateOf?: string }).duplicateOf;
      if (asset.error === "duplicate" && dupOf) {
        const target = await db.query.assets.findFirst({ where: eq(assets.id, dupOf) });
        const clash = await db.query.collectionItems.findFirst({ where: and(eq(collectionItems.collectionId, item.collectionId), eq(collectionItems.assetId, dupOf), ne(collectionItems.id, item.id)) });
        if (clash) {
          await setItemState(db, item.id, { status: "failed", error: `Same content as “${clash.sourceName}” (already in this collection).` });
        } else {
          const media = (target?.media ?? {}) as { durationSec?: number };
          const durationSec = target && (target.kind === "video" || target.kind === "audio") ? (media.durationSec ?? null) : null;
          await setItemState(db, item.id, { assetId: dupOf, status: "uploaded", contentHash: target?.contentHash ?? null, durationSec, error: null });
        }
      } else {
        await setItemState(db, item.id, { status: "failed", error: asset.error ?? "The file could not be processed." });
      }
      continue;
    }
    if (asset.status !== "ready") continue;
    const clash = asset.contentHash ? await db.query.collectionItems.findFirst({ where: and(eq(collectionItems.collectionId, item.collectionId), eq(collectionItems.contentHash, asset.contentHash), ne(collectionItems.id, item.id)) }) : null;
    if (clash) {
      await setItemState(db, item.id, { status: "failed", error: `Same content as “${clash.sourceName}” (already in this collection).` });
      continue;
    }
    const media = asset.media as { durationSec?: number };
    // Subtitle sidecars carry a cue span, not source duration: only recordings count as source time.
    const durationSec = asset.kind === "video" || asset.kind === "audio" ? (media.durationSec ?? null) : null;
    if (item.status === "pending" || item.status === "uploaded") await setItemState(db, item.id, { status: "uploaded", contentHash: asset.contentHash, durationSec, error: null });
  }
}

const ACTIVE = ["queued", "running", "waiting_provider", "cancel_requested"] as const;

/** What indexing the chosen items would do, before anything runs (Example C). */
export async function planIndexing(db: DbOrTx, workspaceId: string, collectionId: string, itemIds: string[] | "all", opts: { sttAvailable: boolean; sttPricePerHourMicros: number | null }) {
  const { items } = await getCollection(db, collectionId, workspaceId);
  const chosen = itemIds === "all" ? items : items.filter((i) => itemIds.includes(i.id));
  const plan = { items: [] as { id: string; sourceName: string; action: "skip_indexed" | "sidecar" | "reuse" | "transcribe" | "needs_transcript" | "not_ready" | "not_media"; durationSec: number }[], sttMinutes: 0, reuseMinutes: 0, sidecarMinutes: 0, estimatedCostMicros: null as number | null };
  for (const i of chosen) {
    const dur = Number(i.durationSec ?? 0);
    const asset = i.assetId ? await db.query.assets.findFirst({ where: eq(assets.id, i.assetId) }) : null;
    let action: (typeof plan.items)[number]["action"];
    if (i.status === "indexed") action = "skip_indexed";
    else if (!asset || asset.status !== "ready") action = "not_ready";
    else if (asset.kind === "document") action = "not_media";
    else if (asset.kind !== "video" && asset.kind !== "audio") action = "not_media";
    else {
      const reused = await db.execute(sql`select 1 from source_transcripts where asset_id = ${asset.id} and workspace_id = ${workspaceId} limit 1`);
      const stem = i.sourceName.replace(/\.[^.]+$/, "").toLowerCase();
      const sidecar = items.some((s) => s.id !== i.id && /\.(srt|vtt)$/i.test(s.sourceName) && s.sourceName.replace(/\.[^.]+$/, "").toLowerCase() === stem);
      action = reused.rows.length ? "reuse" : sidecar ? "sidecar" : opts.sttAvailable ? "transcribe" : "needs_transcript";
    }
    if (action === "reuse") plan.reuseMinutes += dur / 60;
    if (action === "sidecar") plan.sidecarMinutes += dur / 60;
    if (action === "transcribe") plan.sttMinutes += dur / 60;
    plan.items.push({ id: i.id, sourceName: i.sourceName, action, durationSec: dur });
  }
  plan.estimatedCostMicros = opts.sttPricePerHourMicros === null ? (plan.sttMinutes > 0 ? null : 0) : Math.round((plan.sttMinutes / 60) * opts.sttPricePerHourMicros);
  return plan;
}

/** Enqueue indexing for the planned items that need it; items with active jobs are not duplicated. */
export async function enqueueIndexing(db: DbOrTx, workspaceId: string, collectionId: string, itemIds: string[]) {
  const out: { itemId: string; jobId: string; created: boolean }[] = [];
  for (const itemId of itemIds) {
    const active = await db.query.jobs.findFirst({ where: and(eq(jobs.workspaceId, workspaceId), eq(jobs.type, "collection_ingest"), inArray(jobs.status, [...ACTIVE]), sql`${jobs.input}->>'itemId' = ${itemId}`) });
    if (active) {
      out.push({ itemId, jobId: active.id, created: false });
      continue;
    }
    const { job } = await enqueueJob(db, { workspaceId, type: "collection_ingest", input: { itemId, collectionId }, idempotencyKey: null });
    out.push({ itemId, jobId: job.id, created: true });
  }
  return out;
}

function fmtBytes(n: number) {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

/** Attach an uploaded asset; enforces per-file, file-count and aggregate limits. Idempotent per asset. */
export async function addCollectionItem(db: DbOrTx, workspaceId: string, collectionId: string, input: { assetId: string; sourceName: string; bytes: number }) {
  const { limits, items, totals } = await getCollection(db, collectionId, workspaceId);
  const existing = items.find((i) => i.assetId === input.assetId);
  if (existing) return { item: existing, created: false };
  if (items.length + 1 > limits.maxFiles) throw new AppError(413, "collection_limit", `This collection is limited to ${limits.maxFiles} files.`);
  if (input.bytes > limits.maxFileBytes) throw new AppError(413, "collection_limit", `“${input.sourceName}” exceeds the per-file limit.`);
  if (totals.bytes + input.bytes > limits.maxTotalBytes) throw new AppError(413, "collection_limit", "This file would exceed the collection's total size limit.");
  const [item] = await db.insert(collectionItems).values({ id: newId("itm"), collectionId, workspaceId, assetId: input.assetId, sourceName: input.sourceName, bytes: input.bytes, status: "uploaded" }).returning();
  return { item: item!, created: true };
}

export async function setItemState(db: DbOrTx, itemId: string, patch: Partial<typeof collectionItems.$inferInsert>) {
  await db.update(collectionItems).set({ ...patch, updatedAt: sql`now()` }).where(eq(collectionItems.id, itemId));
}

/**
 * Theme searches are transparent keyword sets over the transcript (no hidden model): they
 * surface candidates for a human to review; nothing is inferred about who said what.
 */
export const SEARCH_THEMES: Record<string, { label: string; query: string }> = {
  reaction: { label: "Audience reaction", query: "amazing | love | loved | incredible | wow | excited | fantastic | awesome | blown | favourite | favorite | best" },
  outcome: { label: "Practical outcome", query: "learned | learn | now | built | saved | result | results | improved | shipped | cut | faster | able" },
  insight: { label: "Speaker insight", query: "key | reason | matters | secret | trick | realized | realised | lesson | truth | important | biggest" },
  invitation: { label: "Closing invitation", query: "join | next | year | register | see | come | ticket | tickets | invite | together | sign" },
  energy: { label: "Opening energy", query: "welcome | hello | today | ready | let's | lets | excited | big | here" },
};

export interface SearchHit {
  segmentRowId: number;
  transcriptId: string;
  assetId: string;
  startSec: number;
  endSec: number;
  text: string;
  rank: number;
  before: string;
  after: string;
}

export async function searchCollection(db: DbOrTx, workspaceId: string, collectionId: string, opts: { q?: string; theme?: string; limit?: number }): Promise<SearchHit[]> {
  await getCollection(db, collectionId, workspaceId);
  const theme = opts.theme ? SEARCH_THEMES[opts.theme] : undefined;
  const limit = Math.min(50, opts.limit ?? 20);
  const tsq = theme ? sql`to_tsquery('english', ${theme.query})` : sql`websearch_to_tsquery('english', ${opts.q ?? ""})`;
  const r = await db.execute(sql`
    with hits as (
      select s.id, s.transcript_id, s.asset_id, s.start_sec, s.end_sec, s.text,
             ts_rank(to_tsvector('english', s.text), ${tsq}) as rank
      from transcript_segments s
      where s.workspace_id = ${workspaceId} and s.collection_id = ${collectionId}
        and to_tsvector('english', s.text) @@ ${tsq}
      order by rank desc, s.start_sec asc
      limit ${limit}
    )
    select h.*,
      (select p.text from transcript_segments p where p.transcript_id = h.transcript_id and p.collection_id = ${collectionId} and p.end_sec <= h.start_sec + 0.01 order by p.end_sec desc limit 1) as before,
      (select n.text from transcript_segments n where n.transcript_id = h.transcript_id and n.collection_id = ${collectionId} and n.start_sec >= h.end_sec - 0.01 order by n.start_sec asc limit 1) as after
    from hits h order by h.rank desc, h.start_sec asc`);
  return (r.rows as Record<string, unknown>[]).map((x) => ({
    segmentRowId: Number(x.id),
    transcriptId: String(x.transcript_id),
    assetId: String(x.asset_id),
    startSec: Number(x.start_sec),
    endSec: Number(x.end_sec),
    text: String(x.text),
    rank: Number(x.rank),
    before: String(x.before ?? ""),
    after: String(x.after ?? ""),
  }));
}
