import { z } from "zod";
import { getDb, setClaudeRuntimeMode } from "@vs/db";
import { requireOwner, requireSession } from "@/lib/server/auth";
import { claudeStatus } from "@/lib/server/claude";
import { body, json, route } from "@/lib/server/http";

/** Claude runtime status. Contains no secrets: account plan name, check result and variable names only. */
export const GET = route(async () => {
  const s = await requireSession();
  return json(await claudeStatus(s.workspaceId));
});

/** Choose the runtime explicitly. API mode is opt-in; nothing switches to it automatically. */
export const PUT = route(async (req) => {
  const s = await requireOwner();
  const b = await body(req, z.object({ mode: z.enum(["subscription", "api", "off"]) }));
  await setClaudeRuntimeMode(getDb(), s.workspaceId, b.mode);
  return json(await claudeStatus(s.workspaceId, { refresh: b.mode === "subscription" }));
});

/** Re-check the local Claude Code runtime now (no model call, uses no plan usage). */
export const POST = route(async () => {
  const s = await requireOwner();
  return json(await claudeStatus(s.workspaceId, { refresh: true }));
});
