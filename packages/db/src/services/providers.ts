import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../client";
import { newId } from "../ids";
import { providerConfigs } from "../schema";
import { decryptSecret, encryptSecret } from "./crypto";

/** Providers and the env var that may configure each server-side. */
export const PROVIDERS = {
  anthropic: { env: "ANTHROPIC_API_KEY", label: "Claude (Anthropic API)", capabilities: ["planner", "editor", "vision-review"] },
  elevenlabs: { env: "ELEVENLABS_API_KEY", label: "ElevenLabs", capabilities: ["tts", "transcription"] },
  fal: { env: "FAL_KEY", label: "fal", capabilities: ["image-generation", "video-generation"] },
} as const;
export type ProviderId = keyof typeof PROVIDERS;

export async function setProviderSecret(db: DbOrTx, workspaceId: string, provider: ProviderId, secret: string | null, settings: Record<string, unknown> = {}) {
  const values = {
    encryptedSecret: secret ? encryptSecret(secret) : null,
    keyHint: secret ? `…${secret.slice(-4)}` : null,
    settings,
    lastCheck: null,
    updatedAt: sql`now()`,
  };
  await db
    .insert(providerConfigs)
    .values({ id: newId("pcf"), workspaceId, provider, ...values })
    .onConflictDoUpdate({ target: [providerConfigs.workspaceId, providerConfigs.provider], set: values });
}

/** Secret resolution: owner settings (encrypted) first, then server environment. Never returned to clients. */
export async function getProviderSecret(db: DbOrTx, workspaceId: string, provider: ProviderId): Promise<{ secret: string; source: "settings" | "env" } | null> {
  const row = await db.query.providerConfigs.findFirst({ where: and(eq(providerConfigs.workspaceId, workspaceId), eq(providerConfigs.provider, provider)) });
  if (row?.encryptedSecret) return { secret: decryptSecret(row.encryptedSecret), source: "settings" };
  const env = process.env[PROVIDERS[provider].env];
  return env ? { secret: env, source: "env" } : null;
}

export async function recordProviderCheck(db: DbOrTx, workspaceId: string, provider: ProviderId, check: { ok: boolean; message: string; at: string; model?: string }) {
  await db
    .insert(providerConfigs)
    .values({ id: newId("pcf"), workspaceId, provider, lastCheck: check })
    .onConflictDoUpdate({ target: [providerConfigs.workspaceId, providerConfigs.provider], set: { lastCheck: check } });
}

export async function providerStatus(db: DbOrTx, workspaceId: string) {
  const rows = await db.query.providerConfigs.findMany({ where: eq(providerConfigs.workspaceId, workspaceId) });
  return (Object.keys(PROVIDERS) as ProviderId[]).map((p) => {
    const row = rows.find((r) => r.provider === p);
    const source = row?.encryptedSecret ? "settings" : process.env[PROVIDERS[p].env] ? "env" : null;
    return {
      provider: p,
      label: PROVIDERS[p].label,
      capabilities: PROVIDERS[p].capabilities,
      configured: !!source,
      source,
      keyHint: row?.keyHint ?? null,
      lastCheck: (row?.lastCheck as { ok: boolean; message: string; at: string } | null) ?? null,
    };
  });
}

/** Re-encrypt every stored secret with a new key (rotation). */
export async function rotateEncryptionKey(db: DbOrTx, oldKey: string, newKey: string) {
  const rows = await db.query.providerConfigs.findMany();
  for (const r of rows) {
    if (!r.encryptedSecret) continue;
    const plain = decryptSecret(r.encryptedSecret, oldKey);
    await db.update(providerConfigs).set({ encryptedSecret: encryptSecret(plain, newKey) }).where(eq(providerConfigs.id, r.id));
  }
  return rows.length;
}
