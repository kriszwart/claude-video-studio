import { and, eq } from "drizzle-orm";
import { AppError, getDb, getTranscript, schema } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** One recording's full transcript (for extending a quote to neighbouring sentences). */
export const GET = route<{ id: string; itemId: string }>(async (_req, { id, itemId }) => {
  const s = await requireSession();
  const db = getDb();
  const item = await db.query.collectionItems.findFirst({ where: and(eq(schema.collectionItems.id, itemId), eq(schema.collectionItems.collectionId, id), eq(schema.collectionItems.workspaceId, s.workspaceId)) });
  if (!item) throw new AppError(404, "not_found", "Item not found.");
  const transcript = item.transcriptId ? await getTranscript(db, item.transcriptId, s.workspaceId) : null;
  return json({ item, transcript: transcript ? { id: transcript.id, provider: transcript.provider, granularity: transcript.granularity, segments: transcript.segments } : null });
});
