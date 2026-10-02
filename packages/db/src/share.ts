import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * Picture hosting: the owner's own S3-compatible bucket (Cloudflare R2, AWS S3, Backblaze B2,
 * MinIO…) for handing pictures to services that only take web addresses, such as Lanternist.
 * Objects get unguessable names; the link is either a time-limited signed link (default, the
 * bucket stays private) or, when the owner sets a public address for the bucket, a lasting one.
 * Only what the owner sends is uploaded, and only to this bucket.
 */
export const ShareSettings = z.object({
  /** S3 API address, e.g. https://<account>.r2.cloudflarestorage.com. Empty for AWS S3. */
  endpoint: z.union([z.string().url().max(300), z.literal("")]).default(""),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "Bucket names use lowercase letters, digits, dots and dashes."),
  region: z.string().max(40).default("auto"),
  accessKeyId: z.string().min(1).max(200),
  /** The bucket's public address (e.g. an R2 custom domain). Empty: signed links. */
  publicBaseUrl: z.union([z.string().url().max(300), z.literal("")]).default(""),
  /** How long signed links work (S3 allows at most 7 days). */
  linkDays: z.number().int().min(1).max(7).default(7),
  prefix: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).default("fluxtify-shared"),
});
export type ShareSettings = z.infer<typeof ShareSettings>;

export interface SharedFile {
  key: string;
  url: string;
  /** When the link stops working; null for a lasting public address. */
  expiresAt: string | null;
}

async function client(s: ShareSettings, secret: string) {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    ...(s.endpoint ? { endpoint: s.endpoint, forcePathStyle: true } : {}),
    region: s.region === "auto" && !s.endpoint ? "us-east-1" : s.region,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: secret },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4" };

/** Upload a file under an unguessable name and return a link to it. */
export async function shareFile(s: ShareSettings, secret: string, path: string, contentType: string): Promise<SharedFile> {
  const { PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const c = await client(s, secret);
  const key = `${s.prefix}/${randomBytes(18).toString("hex")}.${EXT[contentType] ?? "bin"}`;
  await c.send(new PutObjectCommand({ Bucket: s.bucket, Key: key, Body: await readFile(path), ContentType: contentType, CacheControl: "public, max-age=604800" }));
  if (s.publicBaseUrl) return { key, url: `${s.publicBaseUrl.replace(/\/+$/, "")}/${key}`, expiresAt: null };
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const ttl = s.linkDays * 86_400;
  const url = await getSignedUrl(c, new GetObjectCommand({ Bucket: s.bucket, Key: key }), { expiresIn: ttl });
  return { key, url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
}

export async function unshareFile(s: ShareSettings, secret: string, key: string): Promise<void> {
  const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  await (await client(s, secret)).send(new DeleteObjectCommand({ Bucket: s.bucket, Key: key }));
}

/** Live check: upload a tiny file, fetch it through its link like an outside service would, delete it. */
export async function checkShare(s: ShareSettings, secret: string, tmpPath: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; message: string }> {
  let shared: SharedFile | null = null;
  try {
    shared = await shareFile(s, secret, tmpPath, "image/png");
  } catch (e) {
    return { ok: false, message: `Upload failed: ${(e as Error).message}` };
  }
  try {
    const r = await fetchImpl(shared.url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return { ok: false, message: `Uploaded, but the link answered ${r.status}${s.publicBaseUrl ? "; check the public address" : ""}.` };
    const https = shared.url.startsWith("https://");
    return { ok: true, message: `Uploads work and links open${s.publicBaseUrl ? " (lasting public address)" : ` (signed links, valid ${s.linkDays} day${s.linkDays > 1 ? "s" : ""})`}.${https ? "" : " Links aren't https, so Lanternist won't accept them."}` };
  } catch (e) {
    return { ok: false, message: `Uploaded, but the link didn't open: ${(e as Error).message}` };
  } finally {
    await unshareFile(s, secret, shared.key).catch(() => undefined);
  }
}
