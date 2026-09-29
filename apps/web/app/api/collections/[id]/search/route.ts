import { and, eq, inArray } from "drizzle-orm";
import { AppError, getDb, schema, SEARCH_THEMES, searchCollection } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";
import { serializeAsset } from "@/lib/server/serialize";

export const dynamic = "force-dynamic";

/**
 * Candidate moments: transcript segments matching a free-text query or a transparent theme
 * keyword set, each with the original source, exact in/out, surrounding transcript and a
 * signed URL to play the source excerpt.
 */
export const GET = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") ?? "").slice(0, 200);
  const theme = u.searchParams.get("theme") ?? undefined;
  if (theme && !SEARCH_THEMES[theme]) throw new AppError(400, "invalid_theme", "Unknown theme.");
  if (!q.trim() && !theme) return json({ hits: [], themes: SEARCH_THEMES });
  const db = getDb();
  const hits = await searchCollection(db, s.workspaceId, id, { q, theme, limit: Number(u.searchParams.get("limit") ?? 20) });
  const ids = [...new Set(hits.map((h) => h.assetId))];
  const assets = ids.length ? await db.query.assets.findMany({ where: and(inArray(schema.assets.id, ids), eq(schema.assets.workspaceId, s.workspaceId)) }) : [];
  const items = ids.length ? await db.query.collectionItems.findMany({ where: and(eq(schema.collectionItems.collectionId, id), inArray(schema.collectionItems.assetId, ids)) }) : [];
  const transcripts = new Map<string, { id: string; startSec: number; endSec: number; text: string }[]>();
  for (const tid of new Set(hits.map((h) => h.transcriptId))) {
    const t = await db.query.sourceTranscripts.findFirst({ where: and(eq(schema.sourceTranscripts.id, tid), eq(schema.sourceTranscripts.workspaceId, s.workspaceId)) });
    if (t) transcripts.set(tid, t.segments as { id: string; startSec: number; endSec: number; text: string }[]);
  }
  return json({
    themes: SEARCH_THEMES,
    hits: hits.map((h) => {
      const a = assets.find((x) => x.id === h.assetId);
      const seg = transcripts.get(h.transcriptId)?.find((x) => Math.abs(x.startSec - h.startSec) < 0.002 && Math.abs(x.endSec - h.endSec) < 0.002);
      return { ...h, segmentId: seg?.id ?? null, sourceName: items.find((i) => i.assetId === h.assetId)?.sourceName ?? a?.originalName ?? "", asset: a ? serializeAsset(a) : null };
    }),
  });
});
