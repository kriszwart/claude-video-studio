import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../client";
import { newId } from "../ids";
import { providerConfigs } from "../schema";
import { getProviderSecret } from "./providers";

/**
 * Which Claude runtime AI actions use (PRD §28):
 * - "subscription" (default): the owner's Claude plan through the local Claude Code runtime.
 * - "api": a separately billed Anthropic API key — only when explicitly selected.
 * - "off": AI actions disabled; manual editing and rendering keep working.
 * There is never an automatic switch between them.
 */
export type ClaudeRuntimeMode = "subscription" | "api" | "off";

const ROW = "claude_runtime";

export function defaultClaudeRuntimeMode(): ClaudeRuntimeMode {
  const v = process.env.CLAUDE_RUNTIME;
  return v === "api" || v === "off" ? v : "subscription";
}

export interface ClaudeRuntimeCheckRecord {
  ok: boolean;
  state: string;
  observed: string;
  plan: string | null;
  message: string;
  recovery?: string;
  overrides: string[];
  at: string;
}

export interface ClaudeLimitRecord {
  status: string;
  rateLimitType?: string;
  resetsAt?: string;
  utilization?: number;
  at: string;
}

export interface ClaudeRuntimeSettings {
  mode: ClaudeRuntimeMode;
  /** Whether the mode was chosen in Settings (vs. the server default). */
  explicit: boolean;
  lastCheck: ClaudeRuntimeCheckRecord | null;
  /** Last usage-window status reported by the runtime itself; null when none was reported. */
  lastLimit: ClaudeLimitRecord | null;
}

async function row(db: DbOrTx, workspaceId: string) {
  return db.query.providerConfigs.findFirst({ where: and(eq(providerConfigs.workspaceId, workspaceId), eq(providerConfigs.provider, ROW)) });
}

export async function getClaudeRuntime(db: DbOrTx, workspaceId: string): Promise<ClaudeRuntimeSettings> {
  const r = await row(db, workspaceId);
  const s = (r?.settings ?? {}) as { mode?: ClaudeRuntimeMode; lastLimit?: ClaudeLimitRecord };
  return { mode: s.mode ?? defaultClaudeRuntimeMode(), explicit: !!s.mode, lastCheck: (r?.lastCheck as ClaudeRuntimeCheckRecord | null) ?? null, lastLimit: s.lastLimit ?? null };
}

async function patchSettings(db: DbOrTx, workspaceId: string, patch: Record<string, unknown>) {
  await db
    .insert(providerConfigs)
    .values({ id: newId("pcf"), workspaceId, provider: ROW, settings: patch })
    .onConflictDoUpdate({ target: [providerConfigs.workspaceId, providerConfigs.provider], set: { settings: sql`${providerConfigs.settings} || ${JSON.stringify(patch)}::jsonb`, updatedAt: sql`now()` } });
}

export async function setClaudeRuntimeMode(db: DbOrTx, workspaceId: string, mode: ClaudeRuntimeMode) {
  await patchSettings(db, workspaceId, { mode });
}

export async function recordClaudeLimit(db: DbOrTx, workspaceId: string, limit: ClaudeLimitRecord) {
  await patchSettings(db, workspaceId, { lastLimit: limit });
}

export async function recordClaudeRuntimeCheck(db: DbOrTx, workspaceId: string, check: ClaudeRuntimeCheckRecord) {
  await db
    .insert(providerConfigs)
    .values({ id: newId("pcf"), workspaceId, provider: ROW, lastCheck: check })
    .onConflictDoUpdate({ target: [providerConfigs.workspaceId, providerConfigs.provider], set: { lastCheck: check } });
}

/**
 * The subscription runtime is for a personal local studio only: the owner runs their own
 * Claude Code on their own machine. Anthropic does not allow products to offer claude.ai login
 * or plan rate limits to other users, so a multi-user (password-mode / hosted) studio must use
 * API mode. Same rule as the web app's auth mode.
 */
export function subscriptionRuntimeAllowed(): boolean {
  const m = process.env.STUDIO_AUTH_MODE ?? (process.env.NODE_ENV === "production" ? "password" : "local");
  return m === "local";
}

export const SUBSCRIPTION_NOT_PERSONAL =
  "The Claude subscription runtime is only available in a personal local studio (STUDIO_AUTH_MODE=local, one owner on this computer). A studio that serves other users must use a separately billed API key.";

export const CLAUDE_SETUP_PATH = "/settings#claude";

export interface ClaudeReadiness {
  mode: ClaudeRuntimeMode;
  available: boolean;
  message: string;
  recovery?: string;
  setupUrl: string;
}

/** Whether AI actions can run right now, from stored settings and the last runtime check. */
export async function claudeReadiness(db: DbOrTx, workspaceId: string, rt?: ClaudeRuntimeSettings): Promise<ClaudeReadiness> {
  const r = rt ?? (await getClaudeRuntime(db, workspaceId));
  const base = { mode: r.mode, setupUrl: CLAUDE_SETUP_PATH };
  if (r.mode === "off") return { ...base, available: false, message: "Claude is turned off for this studio, so AI actions are unavailable.", recovery: "Turn it on in Settings → Claude. Manual editing and rendering keep working." };
  if (r.mode === "api") {
    const key = await getProviderSecret(db, workspaceId, "anthropic");
    return key
      ? { ...base, available: true, message: "Claude API mode (separately billed API key)." }
      : { ...base, available: false, message: "Claude API mode is selected but no API key is configured.", recovery: "Add a key in Settings → Claude, or switch back to your Claude Code subscription." };
  }
  if (!subscriptionRuntimeAllowed()) return { ...base, available: false, message: SUBSCRIPTION_NOT_PERSONAL, recovery: "Switch Settings → Claude to API mode and add an API key." };
  if (r.lastCheck?.ok) return { ...base, available: true, message: r.lastCheck.message };
  return {
    ...base,
    available: false,
    message: r.lastCheck?.message ?? "The Claude Code runtime has not been checked yet, so AI actions are unavailable.",
    recovery: r.lastCheck?.recovery ?? "Open Settings → Claude and click “Check runtime”. Manual editing and rendering keep working.",
  };
}
