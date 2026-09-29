import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from "../src/services/crypto";

const k = () => randomBytes(32).toString("base64");
const saved = { cur: process.env.APP_ENCRYPTION_KEY, prev: process.env.APP_ENCRYPTION_KEY_PREVIOUS };
afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = saved.cur;
  process.env.APP_ENCRYPTION_KEY_PREVIOUS = saved.prev;
  if (saved.cur === undefined) delete process.env.APP_ENCRYPTION_KEY;
  if (saved.prev === undefined) delete process.env.APP_ENCRYPTION_KEY_PREVIOUS;
});

describe("secrets at rest", () => {
  it("round-trips, rejects tampering, and survives a key rotation", () => {
    const oldKey = k();
    const newKey = k();
    process.env.APP_ENCRYPTION_KEY = oldKey;
    const enc = encryptSecret("sk-test-123456");
    expect(enc).not.toContain("sk-test");
    expect(decryptSecret(enc)).toBe("sk-test-123456");
    const parts = enc.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
    process.env.APP_ENCRYPTION_KEY = newKey;
    expect(() => decryptSecret(enc)).toThrow();
    process.env.APP_ENCRYPTION_KEY_PREVIOUS = oldKey;
    expect(decryptSecret(enc)).toBe("sk-test-123456");
    const reenc = encryptSecret(decryptSecret(enc));
    delete process.env.APP_ENCRYPTION_KEY_PREVIOUS;
    expect(decryptSecret(reenc)).toBe("sk-test-123456");
  });

  it("hashes passwords with scrypt and verifies in constant time", () => {
    const h = hashPassword("correct horse battery");
    expect(h.startsWith("scrypt:")).toBe(true);
    expect(verifyPassword("correct horse battery", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
  });
});
