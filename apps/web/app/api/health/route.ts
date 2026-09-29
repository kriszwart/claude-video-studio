import { sql } from "drizzle-orm";
import { getDb } from "@vs/db";
import { json, route } from "@/lib/server/http";

export const GET = route(async () => {
  await getDb().execute(sql`select 1`);
  return json({ ok: true });
});
