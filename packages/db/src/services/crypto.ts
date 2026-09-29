import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** AES-256-GCM encryption for provider secrets at rest. Key: APP_ENCRYPTION_KEY (32 bytes, base64). */
function key(k = process.env.APP_ENCRYPTION_KEY): Buffer {
  if (k) {
    const b = Buffer.from(k, "base64");
    if (b.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
    return b;
  }
  if (process.env.NODE_ENV === "production") throw new Error("APP_ENCRYPTION_KEY is required in production");
  return createHash("sha256").update("development-only-encryption-key").digest();
}

export function encryptSecret(plain: string, k?: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(k), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

export function decryptSecret(enc: string, k?: string): string {
  const [v, iv, tag, data] = enc.split(":");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("unsupported secret format");
  const d = createDecipheriv("aes-256-gcm", key(k), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 64);
  return `scrypt:${salt.toString("base64")}:${h.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, salt, h] = stored.split(":");
  if (alg !== "scrypt" || !salt || !h) return false;
  const expected = Buffer.from(h, "base64");
  const got = scryptSync(pw, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(got, expected);
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Redact anything that looks like a credential before logging. */
export function redact(s: string): string {
  return s
    .replace(/sk-ant-[a-zA-Z0-9_-]{8,}/g, "sk-ant-***")
    .replace(/(api[_-]?key|authorization|token|secret)(["'\s:=]+)([^\s"',]{6,})/gi, "$1$2***")
    .replace(/Key [a-f0-9-]{20,}(:[a-f0-9]{8,})?/gi, "Key ***");
}
