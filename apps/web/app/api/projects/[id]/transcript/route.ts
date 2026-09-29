import { AppError, getDb, getProject, getTranscript } from "@vs/db";
import { correctedSegments, findPhraseOccurrences, keptStart } from "@vs/domain";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";

/**
 * The source transcript (immutable), the owner's corrections, and the derived edited view
 * with each segment's mapped output time (null when cut). `?phrase=` lists occurrences.
 */
export const GET = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const db = getDb();
  const { doc } = await getProject(db, id, s.workspaceId);
  if (!doc.program?.transcriptId) throw new AppError(404, "no_transcript", "This project has no transcript yet.");
  const t = await getTranscript(db, doc.program.transcriptId, s.workspaceId);
  const segs = correctedSegments(t.segments, doc.program.corrections);
  const phrase = new URL(req.url).searchParams.get("phrase");
  const fps = doc.format.fps;
  return json({
    transcriptId: t.id,
    provider: t.provider,
    granularity: t.granularity,
    language: t.language,
    segments: segs.map((g, i) => {
      const src = t.segments[i]!;
      const out = keptStart(doc, g.startSec, g.endSec);
      return { id: g.id, startSec: g.startSec, endSec: g.endSec, text: g.text, original: src.text, corrected: src.text !== g.text, outputSec: out === null ? null : out / fps };
    }),
    occurrences: phrase
      ? findPhraseOccurrences(segs, phrase).map((o) => ({ ...o, outputSec: (() => { const f = keptStart(doc, o.startSec, o.endSec); return f === null ? null : f / fps; })() }))
      : undefined,
  });
});
