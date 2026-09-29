import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Object storage abstraction. The local driver keeps blobs under DATA_DIR/storage;
 * the S3 driver targets any S3-compatible service. Workers always operate on a
 * local path obtained through `materialize`.
 */
export interface BlobStore {
  readonly driver: "local" | "s3";
  putFile(key: string, sourcePath: string, contentType?: string): Promise<void>;
  putStream(key: string, body: Readable, contentType?: string): Promise<{ bytes: number; sha256: string }>;
  materialize(key: string): Promise<string>;
  openRead(key: string, range?: { start: number; end: number }): Promise<Readable>;
  size(key: string): Promise<number>;
  delete(key: string): Promise<void>;
}

export function dataDir(): string {
  return resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
}

function safeKey(key: string): string {
  const n = normalize(key).replace(/^([/\\])+/, "");
  if (n.startsWith("..") || n.includes(`${sep}..${sep}`) || !/^[a-zA-Z0-9_./-]+$/.test(n)) throw new Error(`invalid storage key: ${key}`);
  return n;
}

export class LocalBlobStore implements BlobStore {
  readonly driver = "local" as const;
  constructor(private root = join(dataDir(), "storage")) {}

  path(key: string): string {
    return join(this.root, safeKey(key));
  }
  async putFile(key: string, sourcePath: string): Promise<void> {
    const dst = this.path(key);
    await mkdir(dirname(dst), { recursive: true });
    const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
    await copyFile(sourcePath, tmp);
    await rename(tmp, dst);
  }
  async putStream(key: string, body: Readable): Promise<{ bytes: number; sha256: string }> {
    const dst = this.path(key);
    await mkdir(dirname(dst), { recursive: true });
    const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
    const hash = createHash("sha256");
    let bytes = 0;
    body.on("data", (c: Buffer) => {
      hash.update(c);
      bytes += c.length;
    });
    await pipeline(body, createWriteStream(tmp));
    await rename(tmp, dst);
    return { bytes, sha256: hash.digest("hex") };
  }
  async materialize(key: string): Promise<string> {
    const p = this.path(key);
    await stat(p);
    return p;
  }
  async openRead(key: string, range?: { start: number; end: number }): Promise<Readable> {
    return createReadStream(this.path(key), range);
  }
  async size(key: string): Promise<number> {
    return (await stat(this.path(key))).size;
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

/** S3-compatible driver (MinIO, AWS S3, R2…). Loaded lazily so local setups need no SDK. */
export class S3BlobStore implements BlobStore {
  readonly driver = "s3" as const;
  private cacheDir = join(dataDir(), "s3-cache");
  constructor(
    private bucket = process.env.S3_BUCKET ?? "video-studio",
    private endpoint = process.env.S3_ENDPOINT,
  ) {}
  private async client() {
    const { S3Client } = await import("@aws-sdk/client-s3");
    return new S3Client({ endpoint: this.endpoint, region: process.env.S3_REGION ?? "us-east-1", forcePathStyle: true });
  }
  async putFile(key: string, sourcePath: string, contentType?: string) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await this.client();
    const size = (await stat(sourcePath)).size;
    await c.send(new PutObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Body: createReadStream(sourcePath), ContentLength: size, ContentType: contentType }));
  }
  async putStream(key: string, body: Readable, contentType?: string) {
    // Spool locally to learn size + hash, then upload.
    const tmp = join(this.cacheDir, "spool", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dirname(tmp), { recursive: true });
    const hash = createHash("sha256");
    let bytes = 0;
    body.on("data", (c: Buffer) => {
      hash.update(c);
      bytes += c.length;
    });
    await pipeline(body, createWriteStream(tmp));
    await this.putFile(key, tmp, contentType);
    await rm(tmp, { force: true });
    return { bytes, sha256: hash.digest("hex") };
  }
  async materialize(key: string): Promise<string> {
    const local = join(this.cacheDir, safeKey(key));
    try {
      await stat(local);
      return local;
    } catch {
      /* download */
    }
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await this.client();
    const res = await c.send(new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
    await mkdir(dirname(local), { recursive: true });
    await pipeline(res.Body as Readable, createWriteStream(`${local}.part`));
    await rename(`${local}.part`, local);
    return local;
  }
  async openRead(key: string, range?: { start: number; end: number }) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await this.client();
    const res = await c.send(new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Range: range ? `bytes=${range.start}-${range.end}` : undefined }));
    return res.Body as Readable;
  }
  async size(key: string) {
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await this.client();
    const r = await c.send(new HeadObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
    return Number(r.ContentLength ?? 0);
  }
  async delete(key: string) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await this.client();
    await c.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
    await rm(join(this.cacheDir, safeKey(key)), { force: true });
  }
}

let store: BlobStore | undefined;
export function getStore(): BlobStore {
  store ??= process.env.STORAGE_DRIVER === "s3" ? new S3BlobStore() : new LocalBlobStore();
  return store;
}

export function streamFromBuffer(b: Buffer): Readable {
  return Readable.from([b]);
}

// ---- Short-lived signed URLs -------------------------------------------------

export function appSecret(): string {
  const s = process.env.APP_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "production") throw new Error("APP_SECRET (>= 32 chars) is required in production");
  return "development-only-secret-do-not-use-in-production-000";
}

/** Sign an asset download for a workspace; verified by the file route after authorisation. */
export function signAssetUrl(assetId: string, workspaceId: string, ttlSec = 600, disposition: "inline" | "attachment" = "inline"): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = createHmac("sha256", appSecret()).update(`${assetId}.${workspaceId}.${exp}.${disposition}`).digest("base64url");
  return `/api/files/${assetId}?exp=${exp}&d=${disposition}&sig=${sig}`;
}

export function verifyAssetSignature(assetId: string, workspaceId: string, exp: number, disposition: string, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const expected = createHmac("sha256", appSecret()).update(`${assetId}.${workspaceId}.${exp}.${disposition}`).digest();
  const given = Buffer.from(sig, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
