import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { dataDir, getDb, getStore, insertReadyAsset, JobError, newId, schema, setStage, type AssetRow, type JobRow } from "@vs/db";
import type { ProjectDocument } from "@vs/domain";
import { opaqueLuma, probeMedia, type ResolvedAssetFile } from "@vs/rendering";

export interface JobContext {
  job: JobRow;
  workerId: string;
  signal: AbortSignal;
  workDir: string;
  /** Record a stage. `progress` only when actually measured. */
  stage(name: string, progress?: number | null, extra?: Record<string, unknown>): Promise<void>;
  log(msg: string, data?: Record<string, unknown>): void;
}

export type Handler = (ctx: JobContext) => Promise<Record<string, unknown>>;

export function makeStage(job: JobRow, workerId: string) {
  let last = 0;
  let lastName = "";
  return async (name: string, progress: number | null = null, extra: Record<string, unknown> = {}) => {
    const now = Date.now();
    // Throttle measured-progress updates; always publish stage changes.
    if (name === lastName && now - last < 800 && progress !== 1) return;
    last = now;
    lastName = name;
    await setStage(job.id, workerId, name, progress, extra);
  };
}

export async function jobWorkDir(jobId: string): Promise<string> {
  const d = join(dataDir(), "work", jobId);
  await mkdir(d, { recursive: true });
  return d;
}

export async function cleanupWorkDir(jobId: string) {
  if (process.env.KEEP_WORK_DIRS === "1") return;
  await rm(join(dataDir(), "work", jobId), { recursive: true, force: true });
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

/** Collect every asset id a document references. */
export function referencedAssetIds(doc: ProjectDocument): string[] {
  const ids = new Set<string>();
  for (const s of doc.scenes) {
    if (s.background.type === "asset") ids.add(s.background.assetId);
    for (const l of s.layers) if ((l.kind === "image" || l.kind === "video") && l.assetId) ids.add(l.assetId);
  }
  for (const t of doc.audio) ids.add(t.assetId);
  if (doc.brand.logoAssetId) ids.add(doc.brand.logoAssetId);
  for (const f of [doc.brand.fonts.heading, doc.brand.fonts.body]) if (f.assetId) ids.add(f.assetId);
  if (doc.program) ids.add(doc.program.sourceAssetId);
  for (const b of doc.beats) if (b.assetId) ids.add(b.assetId);
  return [...ids];
}

function renderKind(a: AssetRow): ResolvedAssetFile["kind"] {
  // SVGs are rasterised at ingest; renders use the PNG derivative.
  return a.kind === "svg" ? "image" : (a.kind as ResolvedAssetFile["kind"]);
}

/** Materialise referenced assets locally for a render. Missing or foreign assets are errors. */
export async function resolveAssets(workspaceId: string, ids: string[]): Promise<Map<string, ResolvedAssetFile>> {
  const db = getDb();
  const store = getStore();
  const out = new Map<string, ResolvedAssetFile>();
  for (const id of ids) {
    const a = await db.query.assets.findFirst({ where: eq(schema.assets.id, id) });
    if (!a || a.workspaceId !== workspaceId) throw new JobError("asset_missing", `Asset ${id} is not available in this workspace.`, false, "Replace the missing media in the scene inspector.");
    if (a.status !== "ready") throw new JobError("asset_not_ready", `Asset "${a.originalName}" is still ${a.status}.`, a.status === "pending", "Wait for the upload to finish processing or replace the file.");
    const derived = a.derived as { rasterKey?: string };
    const key = a.kind === "svg" && derived.rasterKey ? derived.rasterKey : a.storageKey;
    const path = await store.materialize(key);
    if ((a.kind === "image" || a.kind === "svg") && (a.media as { opaqueLuma?: number }).opaqueLuma === undefined) {
      // Backfill for assets ingested before luminance was measured.
      const luma = await opaqueLuma(path).catch(() => null);
      a.media = { ...(a.media as object), opaqueLuma: luma };
      await db.update(schema.assets).set({ media: a.media }).where(eq(schema.assets.id, a.id));
    }
    const media = a.media as { width?: number; height?: number; durationSec?: number; hasAudio?: boolean; opaqueLuma?: number; font?: { family: string; weight: number; style?: "normal" | "italic" } };
    out.set(id, {
      id,
      path,
      kind: renderKind(a),
      contentHash: a.contentHash ?? id,
      media: { width: media.width, height: media.height, durationSec: media.durationSec, hasAudio: media.hasAudio, opaqueLuma: media.opaqueLuma },
      font: a.kind === "font" ? media.font : undefined,
    });
  }
  return out;
}

/** Store a worker-produced file as an immutable asset (renders, narration, thumbnails, stills). */
export async function registerFile(
  workspaceId: string,
  path: string,
  opts: { kind: AssetRow["kind"]; originalName: string; provenance: Record<string, unknown>; generated?: boolean; isSample?: boolean; mime?: string; probe?: boolean },
): Promise<AssetRow> {
  const contentHashEarly = await sha256File(path);
  if (opts.kind !== "render") {
    // Identical derived artifacts (e.g. an unchanged keyframe) reuse the existing immutable asset.
    const existing = await getDb().query.assets.findFirst({ where: and(eq(schema.assets.workspaceId, workspaceId), eq(schema.assets.contentHash, contentHashEarly), eq(schema.assets.status, "ready"), eq(schema.assets.kind, opts.kind)) });
    if (existing) return existing;
  }
  const id = newId("ast");
  const ext = extname(path) || "";
  const key = `ws/${workspaceId}/assets/${id}/${opts.originalName.replace(/[^a-zA-Z0-9._-]/g, "_") || `file${ext}`}`;
  await getStore().putFile(key, path, opts.mime);
  const bytes = (await stat(path)).size;
  const contentHash = contentHashEarly;
  let media: Record<string, unknown> = {};
  if (opts.probe !== false && ["video", "audio", "image", "render"].includes(opts.kind)) {
    const p = await probeMedia(path).catch(() => null);
    if (p) media = { width: p.video?.width, height: p.video?.height, durationSec: p.durationSec ?? undefined, hasAudio: !!p.audio, codecs: { video: p.video?.codec, audio: p.audio?.codec }, fps: p.video?.fps };
  }
  return insertReadyAsset(getDb(), {
    workspaceId,
    kind: opts.kind,
    storageKey: key,
    contentHash,
    mime: opts.mime ?? mimeFor(ext),
    bytes,
    originalName: opts.originalName,
    media,
    provenance: { ...opts.provenance, createdAt: new Date().toISOString() },
    generated: opts.generated ?? false,
    isSample: opts.isSample ?? false,
    rightsAcknowledged: true,
  });
}

export function mimeFor(ext: string): string {
  const m: Record<string, string> = { ".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".srt": "application/x-subrip", ".vtt": "text/vtt", ".svg": "image/svg+xml", ".json": "application/json", ".webm": "video/webm" };
  return m[ext.toLowerCase()] ?? "application/octet-stream";
}
