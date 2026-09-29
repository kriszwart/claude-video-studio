import { z } from "zod";
import { cookies } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import { AppError, createOwner, createSession, getDb } from "@vs/db";
import { authMode, SESSION_COOKIE } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";

/** First-run owner creation for password mode. Requires SETUP_TOKEN so a public deployment can't be claimed. */
export const POST = route(async (req) => {
  if (authMode() !== "password") throw new AppError(400, "not_password_mode", "Setup is only used in password mode.");
  const b = await body(req, z.object({ email: z.string().email().max(200), password: z.string().min(10).max(200), setupToken: z.string().max(200) }));
  const expected = process.env.SETUP_TOKEN ?? "";
  if (!expected || expected.length !== b.setupToken.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(b.setupToken))) {
    throw new AppError(403, "bad_setup_token", "The setup token is incorrect.", "Use the SETUP_TOKEN value configured on the server.");
  }
  const db = getDb();
  const r = await db.transaction((tx) => createOwner(tx, { email: b.email, password: b.password }));
  const { token, expiresAt } = await createSession(db, r.userId, r.workspaceId);
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: new URL(req.url).protocol === "https:", path: "/", expires: expiresAt });
  return json({ ok: true }, 201);
});
