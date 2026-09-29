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
    if (["succeeded", "failed", "canceled", "uncertain"].includes(job.status)) return job;
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

/** Authorise → PUT bytes (measured progress) → finalize → wait for probe. */
export async function uploadFile(file: File, opts: { rightsAcknowledged: boolean; onProgress?: (fraction: number, stage: string) => void }): Promise<UploadedAsset> {
  const { asset, uploadUrl } = await api<{ asset: UploadedAsset; uploadUrl: string }>("/api/assets/uploads", {
    method: "POST",
    json: { filename: file.name, mime: file.type || "application/octet-stream", bytes: file.size, rightsAcknowledged: opts.rightsAcknowledged },
  });
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.upload.onprogress = (e) => e.lengthComputable && opts.onProgress?.(e.loaded / e.total, "uploading");
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        try {
          const e = JSON.parse(xhr.responseText).error;
          reject(new ApiError(xhr.status, e.code, e.message, e.recovery));
        } catch {
          reject(new ApiError(xhr.status, "upload_failed", "Upload failed."));
        }
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "Network error during upload."));
    xhr.send(file);
  });
  opts.onProgress?.(1, "processing");
  const { job } = await api<{ job: JobLike }>(`/api/assets/${asset.id}/finalize`, { method: "POST" });
  const done = await waitForJob(job.id, (j) => opts.onProgress?.(1, j.stage));
  if (done.status !== "succeeded") throw new ApiError(422, done.error?.code ?? "ingest_failed", done.error?.message ?? "The file could not be processed.", done.error?.recovery);
  const finalId = String(done.result?.assetId ?? asset.id);
  const r = await api<{ asset: UploadedAsset }>(`/api/assets/${finalId}`);
  return r.asset;
}

export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m ? `${m}:${s.toFixed(1).padStart(4, "0")}` : `${s.toFixed(1)}s`;
}
