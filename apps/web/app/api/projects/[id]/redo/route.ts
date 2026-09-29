import { z } from "zod";
import { getDb, undoRedo } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";

export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ baseRevisionId: z.string().max(64) }));
  const r = await getDb().transaction((tx) => undoRedo(tx, { projectId: id, workspaceId: s.workspaceId, baseRevisionId: b.baseRevisionId, direction: "redo" }));
  const h = r.revision.history as { undoStack: string[]; redoStack: string[] };
  return json({ revisionId: r.revision.id, seq: r.revision.seq, doc: r.doc, canUndo: h.undoStack.length > 0, canRedo: h.redoStack.length > 0 });
});
