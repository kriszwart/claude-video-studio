import { z } from "zod";
import { applyProjectOperations, getDb } from "@vs/db";
import { Operation } from "@vs/domain";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";

const Req = z.object({ baseRevisionId: z.string().max(64), ops: z.array(Operation).min(1).max(200) });

/** Validate/apply typed edits against an explicit base revision; 409 when stale. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, Req);
  const r = await getDb().transaction((tx) => applyProjectOperations(tx, { projectId: id, workspaceId: s.workspaceId, baseRevisionId: b.baseRevisionId, ops: b.ops, actor: "user" }));
  const h = r.revision.history as { undoStack: string[]; redoStack: string[] };
  return json({ revisionId: r.revision.id, seq: r.revision.seq, doc: r.doc, changedSceneIds: r.changedSceneIds, noop: r.noop, canUndo: h.undoStack.length > 0, canRedo: h.redoStack.length > 0 });
});
