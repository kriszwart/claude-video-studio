import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

let pool: pg.Pool | undefined;
let db: Db | undefined;

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://studio:studio@127.0.0.1:5432/studio";
}

export function getDb(): Db {
  if (!db) {
    pool = new pg.Pool({ connectionString: databaseUrl(), max: Number(process.env.DB_POOL_MAX ?? 10) });
    db = drizzle(pool, { schema });
  }
  return db;
}

export function getPool(): pg.Pool {
  getDb();
  return pool!;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}
