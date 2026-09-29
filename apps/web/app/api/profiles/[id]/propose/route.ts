import { z } from "zod";
import { AppError, getDb, getProfile } from "@vs/db";
import { applyChanges, proposeFromFeedback } from "@vs/domain";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";

/**
 * Feedback → proposed profile change. Explicit rules; clauses it can't map are returned as
 * "unmatched" rather than guessed. Nothing is saved — saving is a separate user action.
 */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ feedback: z.string().min(1).max(2000), baseVersion: z.number().int().positive() }));
  const { versions } = await getProfile(getDb(), id, s.workspaceId);
  const base = versions.find((v) => v.version === b.baseVersion);
  if (!base) throw new AppError(404, "not_found", "Profile version not found.");
  const { changes, unmatched } = proposeFromFeedback(base.data, b.feedback);
  return json({ baseVersion: b.baseVersion, changes, unmatched, proposed: applyChanges(base.data, changes) });
});
