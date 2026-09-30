import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../client";
import { newId } from "../ids";
import { providerConfigs } from "../schema";
import { decryptSecret, encryptSecret } from "./crypto";

/** Providers and the env var that may configure each server-side. */
export const PROVIDERS = {
  anthropic: { env: "ANTHROPIC_API_KEY", label: "Claude API key (optional, billed separately)", capabilities: ["planner", "editor"] },
  elevenlabs: { env: "ELEVENLABS_API_KEY", label: "ElevenLabs", capabilities: ["tts", "transcription"] },
  fal: { env: "FAL_KEY", label: "fal", capabilities: ["image-generation", "video-generation"] },
  pexels: { env: "PEXELS_API_KEY", label: "Pexels (free stock footage key)", capabilities: ["footage-search"] },
  omnivoice: { env: "OMNIVOICE_API_KEY", label: "OmniVoice (local voice server)", capabilities: ["tts"] },
  pixabay: { env: "PIXABAY_API_KEY", label: "Pixabay (free stock footage key)", capabilities: ["footage-search"] },
} as const;
export type ProviderId = keyof typeof PROVIDERS;

export async function setProviderSecret(db: DbOrTx, workspaceId: string, provider: ProviderId, secret: string | null) {
  // Changing the key keeps model/price settings; the previous live check no longer applies.
  const values = {
    encryptedSecret: secret ? encryptSecret(secret) : null,
    keyHint: secret ? `…${secret.slice(-4)}` : null,
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
    // OmniVoice is configured by its server address; an API key is optional.
    const omni = p === "omnivoice" ? ((row?.settings as { baseUrl?: string } | undefined)?.baseUrl ? "settings" : process.env.OMNIVOICE_BASE_URL ? "env" : null) : undefined;
    const source = omni !== undefined ? omni : row?.encryptedSecret ? "settings" : process.env[PROVIDERS[p].env] ? "env" : null;
    return {
      provider: p,
      label: PROVIDERS[p].label,
      capabilities: PROVIDERS[p].capabilities,
      configured: !!source,
      source,
      keyHint: row?.keyHint ?? null,
      lastCheck: (row?.lastCheck as { ok: boolean; message: string; at: string } | null) ?? null,
      settings: (row?.settings as Record<string, unknown>) ?? {},
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

/** Non-secret provider settings (e.g. model endpoints and owner-entered prices). */
export async function setProviderSettings(db: DbOrTx, workspaceId: string, provider: ProviderId, settings: Record<string, unknown>) {
  await db
    .insert(providerConfigs)
    .values({ id: newId("pcf"), workspaceId, provider, settings })
    .onConflictDoUpdate({ target: [providerConfigs.workspaceId, providerConfigs.provider], set: { settings, updatedAt: sql`now()` } });
}

export async function getProviderSettings(db: DbOrTx, workspaceId: string, provider: ProviderId): Promise<Record<string, unknown>> {
  const row = await db.query.providerConfigs.findFirst({ where: and(eq(providerConfigs.workspaceId, workspaceId), eq(providerConfigs.provider, provider)) });
  return (row?.settings as Record<string, unknown>) ?? {};
}

/** OmniVoice server settings (address, model, voices) with env fallback, plus the optional key. */
export async function getOmniVoiceConfig(db: DbOrTx, workspaceId: string): Promise<{ settings: { baseUrl: string; model?: string; voices?: { name: string; label?: string; instructions?: string; language?: string }[] }; apiKey?: string } | null> {
  const row = await db.query.providerConfigs.findFirst({ where: and(eq(providerConfigs.workspaceId, workspaceId), eq(providerConfigs.provider, "omnivoice")) });
  const st = (row?.settings ?? {}) as { baseUrl?: string; model?: string; voices?: { name: string; label?: string; instructions?: string; language?: string }[] };
  const baseUrl = st.baseUrl || process.env.OMNIVOICE_BASE_URL;
  if (!baseUrl) return null;
  const key = await getProviderSecret(db, workspaceId, "omnivoice");
  return { settings: { baseUrl, model: st.model || process.env.OMNIVOICE_MODEL || undefined, voices: st.voices ?? [] }, apiKey: key?.secret };
}
