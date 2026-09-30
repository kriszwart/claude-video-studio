"use client";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public recovery?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown; idempotent?: boolean } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let bodyInit = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    bodyInit = JSON.stringify(init.json);
  }
  if (init.idempotent) headers.set("Idempotency-Key", crypto.randomUUID());
  const res = await fetch(path, { ...init, headers, body: bodyInit, cache: "no-store" });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = data.error ?? {};
    throw new ApiError(res.status, e.code ?? "error", e.message ?? `Request failed (${res.status})`, e.recovery, e.details);
  }
  return data as T;
}

export interface JobLike {
  id: string;
  type: string;
  status: string;
  stage: string;
  progress: number | null;
  error: { code: string; message: string; recovery?: string } | null;
  result: Record<string, unknown> | null;
}

export async function waitForJob(id: string, onUpdate?: (j: JobLike) => void, timeoutMs = 30 * 60_000): Promise<JobLike> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { job } = await api<{ job: JobLike }>(`/api/jobs/${id}`);
    onUpdate?.(job);
    if (["succeeded", "failed", "canceled", "uncertain", "paused"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("Timed out waiting for the job.");
}

export interface UploadedAsset {
  id: string;
  kind: string;
  name: string;
  status: string;
  url: string | null;
  thumbUrl: string | null;
  previewUrl: string | null;
  media: Record<string, unknown>;
  isSample: boolean;
}

const CHUNK = 8 * 1024 * 1024;

function putWhole(url: string, body: Blob, onProgress: (f: number) => void, headers: Record<string, string> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: unknown = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* empty */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const e = (data as { error?: { code: string; message: string; recovery?: string } }).error;
      reject(Object.assign(new ApiError(xhr.status, e?.code ?? "upload_failed", e?.message ?? "Upload failed.", e?.recovery), { data }));
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "Network error during upload."));
    xhr.send(body);
  });
}

/**
 * Resumable upload in 8 MB chunks. After a network error or a server restart the upload
 * asks the server how much arrived and continues from there (up to 5 retries per chunk).
 */
export async function uploadChunks(url: string, file: File, onProgress: (f: number) => void) {
  let offset = (await api<{ received: number }>(url)).received;
  let failures = 0;
  while (offset < file.size) {
    const end = Math.min(file.size, offset + CHUNK) - 1;
    try {
      const r = (await putWhole(url, file.slice(offset, end + 1), (f) => onProgress((offset + f * (end + 1 - offset)) / file.size), { "Content-Range": `bytes ${offset}-${end}/${file.size}` })) as { received: number };
      offset = r.received;
      failures = 0;
    } catch (e) {
      if (++failures > 5) throw e;
      await new Promise((r) => setTimeout(r, 1000 * failures));
      offset = (await api<{ received: number }>(url)).received;
    }
    onProgress(offset / file.size);
  }
}

/** Authorise → PUT bytes (measured progress; chunked + resumable when large) → finalize → wait for probe. */
export async function uploadFile(file: File, opts: { rightsAcknowledged: boolean; onProgress?: (fraction: number, stage: string) => void }): Promise<UploadedAsset> {
  const { asset, uploadUrl } = await api<{ asset: UploadedAsset; uploadUrl: string }>("/api/assets/uploads", {
    method: "POST",
    json: { filename: file.name, mime: file.type || "application/octet-stream", bytes: file.size, rightsAcknowledged: opts.rightsAcknowledged },
  });
  if (file.size > CHUNK) await uploadChunks(uploadUrl, file, (f) => opts.onProgress?.(f, "uploading"));
  else await putWhole(uploadUrl, file, (f) => opts.onProgress?.(f, "uploading"));
  opts.onProgress?.(1, "processing");
  const { job } = await api<{ job: JobLike }>(`/api/assets/${asset.id}/finalize`, { method: "POST" });
  const done = await waitForJob(job.id, (j) => opts.onProgress?.(1, j.stage));
  if (done.status !== "succeeded") throw new ApiError(422, done.error?.code ?? "ingest_failed", done.error?.message ?? "The file could not be processed.", done.error?.recovery);
  const finalId = String(done.result?.assetId ?? asset.id);
  const r = await api<{ asset: UploadedAsset }>(`/api/assets/${finalId}`);
  return r.asset;
}

export function fmtBytes(n: number) {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}

export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m ? `${m}:${s.toFixed(1).padStart(4, "0")}` : `${s.toFixed(1)}s`;
}

/**
 * Add one browser-selected file to an event collection. Already-uploaded files are skipped
 * and interrupted ones resume from the server's offset, so re-selecting a folder after a
 * failure never re-sends completed data (A20).
 */
export async function uploadToCollection(collectionId: string, file: File, opts: { relativePath?: string; rightsAcknowledged: boolean; onProgress?: (fraction: number, stage: string) => void }): Promise<{ itemId: string; skipped: boolean }> {
  const r = await api<{ item: { id: string; status: string }; asset: UploadedAsset | null; uploadUrl: string | null; created: boolean }>(`/api/collections/${collectionId}/uploads`, {
    method: "POST",
    json: { filename: file.name, relativePath: opts.relativePath, mime: file.type || "application/octet-stream", bytes: file.size, rightsAcknowledged: opts.rightsAcknowledged },
  });
  if (!r.created && r.asset && r.asset.status !== "pending") return { itemId: r.item.id, skipped: true };
  if (!r.uploadUrl || !r.asset) throw new ApiError(409, "upload_unavailable", "This file can't be uploaded again.");
  const status = await api<{ received: number; complete: boolean }>(r.uploadUrl);
  if (!status.complete) await uploadChunks(r.uploadUrl, file, (f) => opts.onProgress?.(f, "uploading"));
  opts.onProgress?.(1, "processing");
  await api(`/api/assets/${r.asset.id}/finalize`, { method: "POST" });
  return { itemId: r.item.id, skipped: false };
}
