import { randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { DbOrTx } from "../client";
import { AppError } from "../errors";
import { newId } from "../ids";
import { memberships, sessions, users, workspaces } from "../schema";
import { hashPassword, sha256, verifyPassword } from "./crypto";

export interface SessionInfo {
  userId: string;
  workspaceId: string;
  role: "owner" | "editor" | "viewer";
  email: string;
}

export const SESSION_TTL_DAYS = 14;

export async function userCount(db: DbOrTx): Promise<number> {
  const r = await db.execute(sql`select count(*)::int as n from users`);
  return (r.rows[0] as { n: number }).n;
}

/** First-run owner creation. Only allowed while no user exists. */
export async function createOwner(db: DbOrTx, input: { email: string; password: string | null; displayName?: string; workspaceName?: string }) {
  if ((await userCount(db)) > 0) throw new AppError(409, "owner_exists", "An owner already exists for this installation.");
  if (input.password !== null && input.password.length < 10) throw new AppError(400, "weak_password", "Use a password of at least 10 characters.");
  const userId = newId("usr");
  const workspaceId = newId("ws");
  await db.insert(workspaces).values({ id: workspaceId, name: input.workspaceName ?? "My studio" });
  await db.insert(users).values({ id: userId, email: input.email.toLowerCase(), displayName: input.displayName ?? "", passwordHash: input.password ? hashPassword(input.password) : null });
  await db.insert(memberships).values({ workspaceId, userId, role: "owner" });
  return { userId, workspaceId };
}

/** Local development mode: a single owner without a password, only reachable on loopback. */
export async function ensureLocalOwner(db: DbOrTx) {
  const existing = await db
    .select({ userId: users.id, workspaceId: memberships.workspaceId, email: users.email })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(eq(memberships.role, "owner"))
    .limit(1);
  if (existing[0]) return existing[0];
  const r = await createOwner(db, { email: "owner@localhost", password: null, displayName: "Local owner" });
  return { ...r, email: "owner@localhost" };
}

export async function createSession(db: DbOrTx, userId: string, workspaceId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000);
  await db.insert(sessions).values({ id: sha256(token), userId, workspaceId, expiresAt });
  return { token, expiresAt };
}

export async function login(db: DbOrTx, email: string, password: string) {
  const u = await db.query.users.findFirst({ where: eq(users.email, email.toLowerCase()) });
  // Constant-ish work even when the user doesn't exist.
  const ok = u?.passwordHash ? verifyPassword(password, u.passwordHash) : (verifyPassword(password, "scrypt:AAAAAAAAAAAAAAAAAAAAAA==:" + "A".repeat(88)), false);
  if (!u || !ok) throw new AppError(401, "invalid_credentials", "Email or password is incorrect.");
  const m = await db.query.memberships.findFirst({ where: eq(memberships.userId, u.id) });
  if (!m) throw new AppError(403, "no_workspace", "This account has no workspace.");
  return createSession(db, u.id, m.workspaceId);
}

export async function resolveSession(db: DbOrTx, token: string | undefined): Promise<SessionInfo | null> {
  if (!token) return null;
  const rows = await db
    .select({ userId: sessions.userId, workspaceId: sessions.workspaceId, role: memberships.role, email: users.email })
    .from(sessions)
    .innerJoin(memberships, and(eq(memberships.userId, sessions.userId), eq(memberships.workspaceId, sessions.workspaceId)))
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, sql`now()`)))
    .limit(1);
  return (rows[0] as SessionInfo | undefined) ?? null;
}

export async function destroySession(db: DbOrTx, token: string) {
  await db.delete(sessions).where(eq(sessions.id, sha256(token)));
}
