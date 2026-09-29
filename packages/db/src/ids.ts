import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Prefixed random ids, e.g. "prj_4k2n…". 20 chars of Crockford base32 = 100 bits. */
export function newId(prefix: string): string {
  const bytes = randomBytes(20);
  let s = "";
  for (let i = 0; i < 20; i++) s += ALPHABET[bytes[i]! & 31];
  return `${prefix}_${s}`;
}
