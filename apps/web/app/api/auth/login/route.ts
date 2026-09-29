import { z } from "zod";
import { cookies } from "next/headers";
import { getDb, login } from "@vs/db";
import { SESSION_COOKIE } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";

export const POST = route(async (req) => {
  const b = await body(req, z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }));
  const { token, expiresAt } = await login(getDb(), b.email, b.password);
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: new URL(req.url).protocol === "https:", path: "/", expires: expiresAt });
  return json({ ok: true });
});
