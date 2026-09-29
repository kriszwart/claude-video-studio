import { migrate } from "drizzle-orm/node-postgres/migrator";
import { join } from "node:path";
import { closeDb, getDb } from "./client";

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: join(import.meta.dirname, "..", "migrations") });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations();
  await closeDb();
  console.log("migrations applied");
}
