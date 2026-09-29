import { cookies } from "next/headers";
import { destroySession, getDb } from "@vs/db";
import { SESSION_COOKIE } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";

export const POST = route(async () => {
  const c = await cookies();
  const t = c.get(SESSION_COOKIE)?.value;
  if (t) await destroySession(getDb(), t);
  c.delete(SESSION_COOKIE);
  return json({ ok: true });
});
