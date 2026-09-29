import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPendingAsset, getDb, getStore, JobError, UPLOAD_LIMITS } from "@vs/db";
import type { Handler } from "../context";
import { safeFetch, UnsafeUrlError } from "../net/safeFetch";
import { ingestAsset } from "./ingest";

const TYPES = /^(image\/(png|jpeg|webp|gif|svg\+xml)|video\/(mp4|quicktime|webm)|audio\/(mpeg|mp4|x-m4a|wav|x-wav|aac|ogg|flac))$/;

/**
 * Import a public URL as an asset (FR-03). The fetch is SSRF-guarded; the bytes then go
 * through exactly the same content validation as an upload. Provenance records the
 * source URL and retrieval time; public availability is NOT treated as a usage right.
 */
export const importUrl: Handler = async (ctx) => {
  const url = String(ctx.job.input.url ?? "");
  await ctx.stage("fetching link");
  let r;
  try {
    r = await safeFetch(url, { maxBytes: Math.min(UPLOAD_LIMITS.maxBytes, 200 * 1024 * 1024), allowedTypes: TYPES, signal: ctx.signal, timeoutMs: 60_000 });
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw new JobError(e.code, e.message, e.code === "timeout", e.code === "blocked_address" || e.code === "blocked_port" ? "Only public web addresses can be imported." : "Download the file and upload it instead.");
    throw new JobError("fetch_failed", "The link could not be fetched.", true);
  }
  const name = decodeURIComponent(new URL(r.finalUrl).pathname.split("/").pop() || "imported").slice(0, 120) || "imported";
  const db = getDb();
  const asset = await createPendingAsset(db, {
    workspaceId: ctx.job.workspaceId,
    filename: name.includes(".") ? name : `${name}.${r.contentType.split("/")[1]!.replace("svg+xml", "svg").replace("quicktime", "mov").replace("mpeg", "mp3").replace("x-m4a", "m4a")}`,
    mime: r.contentType,
    bytes: r.body.length,
    rightsAcknowledged: Boolean(ctx.job.input.rightsAcknowledged),
    provenance: { source: "url", sourceUrl: url, finalUrl: r.finalUrl, redirects: r.redirects, retrievedAt: new Date().toISOString(), license: ctx.job.input.license ?? "unknown — public availability is not a usage right" },
  });
  const tmp = join(ctx.workDir, "download");
  await writeFile(tmp, r.body);
  await getStore().putFile(asset.storageKey, tmp, r.contentType);
  await ctx.stage("validating content");
  const res = await ingestAsset({ ...ctx, job: { ...ctx.job, input: { assetId: asset.id } } });
  return { ...res, sourceUrl: url, finalUrl: r.finalUrl };
};
