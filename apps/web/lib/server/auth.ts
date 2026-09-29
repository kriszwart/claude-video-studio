import "server-only";
import { cookies, headers } from "next/headers";
import { AppError, ensureLocalOwner, getDb, resolveSession, userCount, type SessionInfo } from "@vs/db";

export const SESSION_COOKIE = "vs_session";

export function authMode(): "local" | "password" {
  const m = process.env.STUDIO_AUTH_MODE ?? (process.env.NODE_ENV === "production" ? "password" : "local");
  return m === "local" ? "local" : "password";
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * Local development mode is single-owner and passwordless, so it only answers requests
 * addressed to a loopback host (the dev server also binds to 127.0.0.1 by default).
 */
async function assertLoopback() {
  const h = await headers();
  const host = h.get("host") ?? "";
  const fwd = h.get("x-forwarded-for");
  if (!LOOPBACK.test(host) || (fwd && !/^(127\.0\.0\.1|::1)$/.test(fwd.split(",")[0]!.trim()))) {
    throw new AppError(403, "local_mode_remote_request", "This studio runs in local development mode and only accepts requests from this machine.", "Set STUDIO_AUTH_MODE=password and create an owner account to serve remote users.");
  }
}

export async function getSession(): Promise<SessionInfo | null> {
  const db = getDb();
  if (authMode() === "local") {
    await assertLoopback();
    const o = await ensureLocalOwner(db);
    return { userId: o.userId, workspaceId: o.workspaceId, role: "owner", email: o.email };
  }
  const c = await cookies();
  return resolveSession(db, c.get(SESSION_COOKIE)?.value);
}

export async function requireSession(): Promise<SessionInfo> {
  const s = await getSession();
  if (!s) throw new AppError(401, "unauthenticated", "Sign in to continue.");
  return s;
}

export async function requireOwner(): Promise<SessionInfo> {
  const s = await requireSession();
  if (s.role !== "owner") throw new AppError(403, "forbidden", "Only the workspace owner can change this.");
  return s;
}

export async function needsSetup(): Promise<boolean> {
  return authMode() === "password" && (await userCount(getDb())) === 0;
}
