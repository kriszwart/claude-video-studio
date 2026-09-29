import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "../client";
import { AppError, notFound } from "../errors";
import { newId } from "../ids";
import { assets, projectRevisions, projects, templateVersions } from "../schema";

export type AssetRow = typeof assets.$inferSelect;
export type AssetKind = AssetRow["kind"];

export const UPLOAD_LIMITS = {
  maxBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 500 * 1024 * 1024),
  maxSourceSec: Number(process.env.MAX_SOURCE_SECONDS ?? 600),
};

/** Allowed declared types. The ingest job re-checks the real signature with ffprobe/magic bytes. */
const DECLARED: Record<string, AssetKind> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "image/svg+xml": "svg",
  "video/mp4": "video",
  "video/quicktime": "video",
  "video/webm": "video",
  "audio/mpeg": "audio",
  "audio/mp4": "audio",
  "audio/x-m4a": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "audio/wave": "audio",
  "audio/aac": "audio",
  "audio/ogg": "audio",
  "audio/flac": "audio",
  "font/ttf": "font",
  "font/otf": "font",
  "font/woff": "font",
  "font/woff2": "font",
  "application/font-woff": "font",
  "application/x-font-ttf": "font",
};

export function kindForDeclaredType(mime: string, filename: string): AssetKind {
  const k = DECLARED[mime.toLowerCase()];
  if (k) return k;
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const byExt: Record<string, AssetKind> = { png: "image", jpg: "image", jpeg: "image", webp: "image", svg: "svg", mp4: "video", mov: "video", webm: "video", mp3: "audio", m4a: "audio", wav: "audio", aac: "audio", flac: "audio", ogg: "audio", ttf: "font", otf: "font", woff: "font", woff2: "font" };
  const e = byExt[ext];
  if (!e) throw new AppError(415, "unsupported_type", `Files of type "${mime || ext}" are not supported.`, "Upload images (PNG, JPEG, WebP, SVG), video (MP4, MOV, WebM), audio (MP3, M4A, WAV) or fonts (TTF, OTF, WOFF).");
  return e;
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-100) || "file";
}

export async function createPendingAsset(db: DbOrTx, input: { workspaceId: string; filename: string; mime: string; bytes: number; rightsAcknowledged: boolean; provenance?: Record<string, unknown> }) {
  if (!Number.isFinite(input.bytes) || input.bytes <= 0) throw new AppError(400, "invalid_size", "Upload size is required.");
  if (input.bytes > UPLOAD_LIMITS.maxBytes) {
    throw new AppError(413, "too_large", `Files are limited to ${Math.round(UPLOAD_LIMITS.maxBytes / 1024 / 1024)} MB.`, "Compress or trim the file, or use a collection import for large event libraries.");
  }
  const kind = kindForDeclaredType(input.mime, input.filename);
  const id = newId("ast");
  const name = sanitizeFilename(input.filename);
  const [row] = await db
    .insert(assets)
    .values({
      id,
      workspaceId: input.workspaceId,
      kind,
      status: "pending",
      storageKey: `ws/${input.workspaceId}/assets/${id}/original-${name}`,
      mime: input.mime,
      bytes: input.bytes,
      originalName: name,
      rightsAcknowledged: input.rightsAcknowledged,
      provenance: { source: "upload", uploadedAt: new Date().toISOString(), ...input.provenance },
    })
    .returning();
  return row!;
}

export async function insertReadyAsset(db: DbOrTx, values: Omit<typeof assets.$inferInsert, "id" | "status"> & { id?: string }) {
  const [row] = await db.insert(assets).values({ ...values, id: values.id ?? newId("ast"), status: "ready" }).returning();
  return row!;
}

export async function getAsset(db: DbOrTx, id: string, workspaceId: string) {
  const a = await db.query.assets.findFirst({ where: and(eq(assets.id, id), eq(assets.workspaceId, workspaceId)) });
  if (!a) throw notFound("Asset");
  return a;
}

export async function getAssetsByIds(db: DbOrTx, ids: string[], workspaceId: string) {
  if (ids.length === 0) return [];
  return db.query.assets.findMany({ where: and(inArray(assets.id, ids), eq(assets.workspaceId, workspaceId)) });
}

export async function listAssets(db: DbOrTx, workspaceId: string, opts: { kind?: AssetKind; q?: string; includeRenders?: boolean; limit?: number } = {}) {
  const conds = [eq(assets.workspaceId, workspaceId), inArray(assets.status, ["ready", "pending", "failed"])];
  if (opts.kind) conds.push(eq(assets.kind, opts.kind));
  else if (!opts.includeRenders) conds.push(sql`${assets.kind} not in ('render','document')`);
  if (opts.q) conds.push(ilike(assets.originalName, `%${opts.q.replace(/[%_]/g, "")}%`));
  return db.query.assets.findMany({ where: and(...conds), orderBy: desc(assets.createdAt), limit: opts.limit ?? 200 });
}

export async function findDuplicate(db: DbOrTx, workspaceId: string, contentHash: string, excludeId: string) {
  return db.query.assets.findFirst({
    where: and(eq(assets.workspaceId, workspaceId), eq(assets.contentHash, contentHash), eq(assets.status, "ready"), sql`${assets.id} <> ${excludeId}`, sql`${assets.kind} <> 'render'`),
  });
}

/** Where an asset is used: current revisions of projects and published template versions. */
export async function assetUsage(db: DbOrTx, workspaceId: string, assetId: string) {
  const needle = `%"${assetId}"%`;
  const proj = await db
    .select({ id: projects.id, title: projects.title, status: projects.status })
    .from(projects)
    .innerJoin(projectRevisions, eq(projectRevisions.id, projects.currentRevisionId))
    .where(and(eq(projects.workspaceId, workspaceId), sql`${projectRevisions.document}::text like ${needle}`));
  const tpl = await db
    .select({ id: templateVersions.id, templateId: templateVersions.templateId, version: templateVersions.version })
    .from(templateVersions)
    .where(sql`${templateVersions.definition}::text like ${needle}`);
  return { projects: proj, templates: tpl };
}
