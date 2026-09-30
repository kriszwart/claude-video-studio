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
/** Footage-search imports (Internet Archive, Wikimedia Commons, Pexels, Pixabay) carry their licence record. */
interface FootageInput {
  source: string;
  id: string;
  kind: "video" | "image";
  title: string;
  creator: string | null;
  pageUrl: string;
  license: { status: string; name: string; url: string | null; attributionRequired: boolean; attribution: string | null };
  confirmedUnknownLicense?: boolean;
}

/** Test seam (non-production only): footage served by the local footage fixture server. */
function footageFetchOptions() {
  const trusted = process.env.NODE_ENV !== "production" ? (process.env.VS_TEST_TRUSTED_OUTPUT ?? "").split(",").filter(Boolean) : [];
  return trusted.length ? { trustAddresses: trusted.map((t) => t.split(":")[0]!), allowPorts: trusted.map((t) => Number(t.split(":")[1])) } : {};
}

export const importUrl: Handler = async (ctx) => {
  const url = String(ctx.job.input.url ?? "");
  const footage = (ctx.job.input.footage as FootageInput | undefined) ?? null;
  await ctx.stage(footage ? `downloading from ${footage.source.replace("_", " ")}` : "fetching link");
  let r;
  try {
    r = await safeFetch(url, { maxBytes: Math.min(UPLOAD_LIMITS.maxBytes, 200 * 1024 * 1024), allowedTypes: TYPES, signal: ctx.signal, timeoutMs: footage ? 180_000 : 60_000, ...(footage ? footageFetchOptions() : {}) });
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw new JobError(e.code, e.message, e.code === "timeout", e.code === "blocked_address" || e.code === "blocked_port" ? "Only public web addresses can be imported." : "Download the file and upload it instead.");
    throw new JobError("fetch_failed", "The link could not be fetched.", true);
  }
  const fromUrl = decodeURIComponent(new URL(r.finalUrl).pathname.split("/").pop() || "imported").slice(0, 120) || "imported";
  const ext = /\.[a-z0-9]{2,4}$/i.exec(fromUrl)?.[0] ?? "";
  const name = footage ? `${footage.title.replace(/[^\p{L}\p{N} ,.'()-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 100) || footage.id}${ext}` : fromUrl;
  const db = getDb();
  const asset = await createPendingAsset(db, {
    workspaceId: ctx.job.workspaceId,
    filename: name.includes(".") ? name : `${name}.${r.contentType.split("/")[1]!.replace("svg+xml", "svg").replace("quicktime", "mov").replace("mpeg", "mp3").replace("x-m4a", "m4a")}`,
    mime: r.contentType,
    bytes: r.body.length,
    rightsAcknowledged: Boolean(ctx.job.input.rightsAcknowledged),
    provenance: footage
      ? {
          source: "footage",
          footageSource: footage.source,
          footageId: footage.id,
          title: footage.title,
          creator: footage.creator,
          pageUrl: footage.pageUrl,
          sourceUrl: url,
          finalUrl: r.finalUrl,
          retrievedAt: new Date().toISOString(),
          license: footage.license.name,
          licenseStatus: footage.license.status,
          licenseUrl: footage.license.url,
          attributionRequired: footage.license.attributionRequired,
          attribution: footage.license.attribution,
          ...(footage.confirmedUnknownLicense ? { licenseConfirmedByOwner: true } : {}),
        }
      : { source: "url", sourceUrl: url, finalUrl: r.finalUrl, redirects: r.redirects, retrievedAt: new Date().toISOString(), license: ctx.job.input.license ?? "unknown — public availability is not a usage right" },
  });
  const tmp = join(ctx.workDir, "download");
  await writeFile(tmp, r.body);
  await getStore().putFile(asset.storageKey, tmp, r.contentType);
  await ctx.stage("validating content");
  const res = await ingestAsset({ ...ctx, job: { ...ctx.job, input: { assetId: asset.id } } });
  return { ...res, sourceUrl: url, finalUrl: r.finalUrl };
};
