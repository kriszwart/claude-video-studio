/**
 * Re-encrypt stored provider keys with the current APP_ENCRYPTION_KEY.
 *   APP_ENCRYPTION_KEY=<new> APP_ENCRYPTION_KEY_PREVIOUS=<old> tsx scripts/rotate-secrets.ts
 * Afterwards remove APP_ENCRYPTION_KEY_PREVIOUS. Secrets are never printed.
 */
import { eq } from "drizzle-orm";
import { closeDb, decryptSecret, encryptSecret, getDb, schema } from "@vs/db";

const db = getDb();
const rows = await db.query.providerConfigs.findMany();
let n = 0;
for (const r of rows) {
  if (!r.encryptedSecret) continue;
  const plain = decryptSecret(r.encryptedSecret);
  await db.update(schema.providerConfigs).set({ encryptedSecret: encryptSecret(plain) }).where(eq(schema.providerConfigs.id, r.id));
  n++;
}
console.log(`re-encrypted ${n} provider secret(s)`);
await closeDb();
