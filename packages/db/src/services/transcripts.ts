import { and, asc, eq } from "drizzle-orm";
import {
  correctedSegments,
  programCaptionCues,
  resolveBeats,
  withResolvedBeats,
  type Operation,
  type ProjectDocument,
  type TranscriptSegment,
} from "@vs/domain";
import type { DbOrTx } from "../client";
import { notFound } from "../errors";
import { newId } from "../ids";
import { sourceTranscripts, transcriptSegments } from "../schema";

export interface SaveTranscriptInput {
  workspaceId: string;
  assetId: string;
  provider: string;
  language?: string | null;
  granularity: "word" | "segment";
  segments: Omit<TranscriptSegment, "id">[];
  collectionId?: string | null;
}

/** Store an immutable machine transcript plus its searchable segment rows. */
export async function saveTranscript(db: DbOrTx, input: SaveTranscriptInput) {
  const id = newId("trn");
  const segments: TranscriptSegment[] = input.segments.map((s, i) => ({ ...s, id: `${id.slice(4, 12)}s${String(i + 1).padStart(4, "0")}` }));
  await db.insert(sourceTranscripts).values({ id, workspaceId: input.workspaceId, assetId: input.assetId, provider: input.provider, language: input.language ?? null, granularity: input.granularity, segments });
  if (segments.length) {
    for (let i = 0; i < segments.length; i += 500) {
      await db.insert(transcriptSegments).values(
        segments.slice(i, i + 500).map((s) => ({ workspaceId: input.workspaceId, collectionId: input.collectionId ?? null, transcriptId: id, assetId: input.assetId, startSec: s.startSec, endSec: s.endSec, text: s.text })),
      );
    }
  }
  return { id, segments };
}

export async function getTranscript(db: DbOrTx, transcriptId: string, workspaceId: string) {
  const row = await db.query.sourceTranscripts.findFirst({ where: and(eq(sourceTranscripts.id, transcriptId), eq(sourceTranscripts.workspaceId, workspaceId)) });
  if (!row) throw notFound("Transcript");
  return { ...row, segments: row.segments as TranscriptSegment[] };
}

/** Latest transcript for an asset (reused across sibling variants: never re-transcribed). */
export async function latestTranscriptForAsset(db: DbOrTx, assetId: string, workspaceId: string) {
  const rows = await db.query.sourceTranscripts.findMany({ where: and(eq(sourceTranscripts.assetId, assetId), eq(sourceTranscripts.workspaceId, workspaceId)), orderBy: [asc(sourceTranscripts.createdAt)] });
  const row = rows.at(-1);
  return row ? { ...row, segments: row.segments as TranscriptSegment[] } : null;
}

export function captionStyleFor(doc: ProjectDocument) {
  return doc.program?.style === "social" || doc.format.aspect === "9:16" ? { maxWords: 3, maxChars: 20 } : { maxWords: 7, maxChars: 42 };
}

const PROGRAM_OPS = new Set<Operation["op"]>(["correctTranscript", "acceptCuts", "restoreSourceRange", "setProgram", "setBeats", "updateBeat", "mapBeatToTranscriptOccurrence"]);

export function touchesProgram(ops: Operation[]) {
  return ops.some((o) => PROGRAM_OPS.has(o.op));
}

/**
 * Derived program state after an edit: beats re-resolved against the corrected transcript
 * and the current EDL, and transcript captions regenerated from corrected text. Runs inside
 * the same revision as the edit so the saved document is always consistent.
 */
export async function deriveProgramState(db: DbOrTx, doc: ProjectDocument, workspaceId: string, opts: { regenerateCaptions: boolean }): Promise<ProjectDocument> {
  if (!doc.program?.transcriptId) return doc;
  const t = await getTranscript(db, doc.program.transcriptId, workspaceId);
  const segs = correctedSegments(t.segments, doc.program.corrections);
  const next = structuredClone(doc);
  next.beats = withResolvedBeats(next, resolveBeats(next, segs));
  if (opts.regenerateCaptions) {
    const others = next.captions.cues.filter((c) => !(c.anchor.type === "source" && c.id.startsWith("cue_")));
    next.captions.cues = [...others, ...programCaptionCues(segs, doc.program.sourceAssetId, captionStyleFor(doc))];
  }
  return next;
}
