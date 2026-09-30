import "server-only";
import { AppError, claudeReadiness, getClaudeRuntime, getDb, getProviderSecret, recordClaudeRuntimeCheck, subscriptionRuntimeAllowed, type ClaudeReadiness } from "@vs/db";
import { checkClaudeRuntime, detectBillingOverrides } from "@vs/providers";

/** A successful check is trusted for this long; a failed one is re-run sooner so a fresh login shows up. */
const OK_TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 30_000;
const inflight = new Map<string, Promise<unknown>>();

/**
 * Check the local Claude Code runtime (no model call — it only asks which account is signed in)
 * and store the result. Concurrent callers share one check.
 */
export async function refreshRuntimeCheck(workspaceId: string) {
  const running = inflight.get(workspaceId);
  if (running) return running;
  const p = (async () => {
    const check = await checkClaudeRuntime({ timeoutMs: 45_000 });
    await recordClaudeRuntimeCheck(getDb(), workspaceId, check);
    return check;
  })().finally(() => inflight.delete(workspaceId));
  inflight.set(workspaceId, p);
  return p;
}

/** Readiness for AI actions, re-checking the subscription runtime when the last check is stale. */
export async function claudeStatus(workspaceId: string, opts: { refresh?: boolean } = {}) {
  const db = getDb();
  let rt = await getClaudeRuntime(db, workspaceId);
  // Never start Claude Code for a multi-user studio (see subscriptionRuntimeAllowed).
  if (rt.mode === "subscription" && subscriptionRuntimeAllowed()) {
    const age = rt.lastCheck ? Date.now() - Date.parse(rt.lastCheck.at) : Infinity;
    if (opts.refresh || age > (rt.lastCheck?.ok ? OK_TTL_MS : FAIL_TTL_MS)) {
      await refreshRuntimeCheck(workspaceId);
      rt = await getClaudeRuntime(db, workspaceId);
    }
  }
  const readiness = await claudeReadiness(db, workspaceId, rt);
  const apiKey = await getProviderSecret(db, workspaceId, "anthropic");
  return {
    readiness,
    runtime: {
      mode: rt.mode,
      explicit: rt.explicit,
      subscriptionAllowed: subscriptionRuntimeAllowed(),
      lastCheck: rt.lastCheck,
      // Only what the runtime itself reported; the studio never estimates remaining quota.
      lastLimit: rt.lastLimit,
      apiKeyConfigured: !!apiKey,
      apiKeySource: apiKey?.source ?? null,
      // Variable names only, never values.
      overrides: detectBillingOverrides(),
    },
  };
}

/** Throw a clear 412 with a setup link when AI actions can't run. */
export async function requireClaude(workspaceId: string): Promise<ClaudeReadiness> {
  const { readiness } = await claudeStatus(workspaceId);
  if (!readiness.available) throw new AppError(412, "claude_unavailable", readiness.message, `${readiness.recovery ?? ""} Setup: ${readiness.setupUrl}`.trim());
  return readiness;
}
