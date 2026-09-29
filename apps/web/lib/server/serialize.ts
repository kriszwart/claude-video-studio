import "server-only";
import { signAssetUrl, type AssetRow, type JobRow, schema } from "@vs/db";

type ExportRow = typeof schema.exportsTable.$inferSelect;

export function serializeAsset(a: AssetRow) {
  const derived = a.derived as { thumbKey?: string; proxyKey?: string; rasterKey?: string; peaks?: number[] };
  const ready = a.status === "ready";
  const visual = a.kind === "image" || a.kind === "render" ? signAssetUrl(a.id, a.workspaceId) : a.kind === "svg" && derived.rasterKey ? signAssetUrl(a.id, a.workspaceId, { variant: "raster" }) : null;
  return {
    id: a.id,
    kind: a.kind,
    status: a.status,
    name: a.originalName,
    bytes: a.bytes,
    mime: a.mime,
    media: a.media,
    isSample: a.isSample,
    generated: a.generated,
    provenance: a.provenance,
    error: a.error,
    createdAt: a.createdAt,
    url: ready ? signAssetUrl(a.id, a.workspaceId) : null,
    downloadUrl: ready ? signAssetUrl(a.id, a.workspaceId, { disposition: "attachment" }) : null,
    previewUrl: ready ? (derived.proxyKey ? signAssetUrl(a.id, a.workspaceId, { variant: "proxy" }) : visual ?? signAssetUrl(a.id, a.workspaceId)) : null,
    thumbUrl: ready ? (derived.thumbKey ? signAssetUrl(a.id, a.workspaceId, { variant: "thumb" }) : visual) : null,
    peaks: derived.peaks ?? null,
  };
}
export type AssetDTO = ReturnType<typeof serializeAsset>;

export function serializeJob(j: JobRow) {
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    stage: j.stage,
    progress: j.progress,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    projectId: j.projectId,
    revisionId: j.revisionId,
    error: j.error,
    result: j.result,
    providerRequestId: j.providerRequestId,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
  };
}
export type JobDTO = ReturnType<typeof serializeJob>;

export function serializeExport(e: ExportRow) {
  const v = e.verification as { checks?: { name: string; ok: boolean; detail: string; severity: string }[]; loudness?: { lufs: number; truePeakDb: number } | null; warnings?: string[] };
  return {
    id: e.id,
    kind: e.kind,
    revisionId: e.revisionId,
    jobId: e.jobId,
    width: e.width,
    height: e.height,
    durationSec: e.durationSec,
    bundleHash: e.bundleHash,
    createdAt: e.createdAt,
    videoUrl: signAssetUrl(e.videoAssetId, e.workspaceId),
    downloadUrl: signAssetUrl(e.videoAssetId, e.workspaceId, { disposition: "attachment" }),
    thumbUrl: e.thumbnailAssetId ? signAssetUrl(e.thumbnailAssetId, e.workspaceId) : null,
    srtUrl: e.captionsSrtAssetId ? signAssetUrl(e.captionsSrtAssetId, e.workspaceId, { disposition: "attachment" }) : null,
    vttUrl: e.captionsVttAssetId ? signAssetUrl(e.captionsVttAssetId, e.workspaceId, { disposition: "attachment" }) : null,
    checks: v.checks ?? [],
    loudness: v.loudness ?? null,
    warnings: v.warnings ?? [],
  };
}
export type ExportDTO = ReturnType<typeof serializeExport>;
