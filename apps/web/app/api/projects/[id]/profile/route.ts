import { z } from "zod";
import { applyProjectOperations, getDb, profileSnapshot } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";
import { projectView } from "@/lib/server/projects";

/** Pin a saved profile version to this project (a normal, undoable revision). */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ baseRevisionId: z.string().max(64), profileId: z.string().max(64), version: z.number().int().positive() }));
  const db = getDb();
  await db.transaction(async (tx) => {
    const profile = await profileSnapshot(tx, b.profileId, s.workspaceId, b.version);
    await applyProjectOperations(tx, { projectId: id, workspaceId: s.workspaceId, baseRevisionId: b.baseRevisionId, ops: [{ op: "applyCreativeProfile", profile }], actor: "user", action: `apply profile “${profile.name}” v${b.version}` });
  });
  return json(await projectView(id, s.workspaceId));
});
