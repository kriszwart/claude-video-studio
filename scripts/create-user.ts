/**
 * Operator CLI: create a workspace owner (or reset their password).
 *   tsx scripts/create-user.ts <email> <password> [workspace name]
 * Reads DATABASE_URL from the environment. There is no HTTP equivalent by design.
 */
import { closeDb, getDb, upsertWorkspaceOwner } from "@vs/db";

const [email, password, name] = process.argv.slice(2);
if (!email || !password) {
  console.error("usage: tsx scripts/create-user.ts <email> <password> [workspace name]");
  process.exit(2);
}
const r = await upsertWorkspaceOwner(getDb(), { email, password, workspaceName: name ?? `${email}'s studio` });
console.log(JSON.stringify(r));
await closeDb();
