import { isDeepStrictEqual } from "node:util";
import type { Actor, ProjectDocument } from "@vs/domain";
import type { DbOrTx } from "../client";
import { AppError } from "../errors";
import { getTranscript } from "./transcripts";

const EPS = 0.002;

/**
 * Quote integrity (FR-16, A19). Any new or changed quote scene is re-checked against the
 * stored transcript: the text must be the verbatim kept segments, the clip must contain
 * every spoken word without reaching into the neighbouring segments, and the scene must
 * play exactly that range with sound. The assistant may not alter quotes or their captions.
 */
export async function verifyQuoteScenes(db: DbOrTx, workspaceId: string, before: ProjectDocument | null, after: ProjectDocument, actor: Actor | "system" = "user") {
  const prevScenes = new Map((before?.scenes ?? []).map((s) => [s.id, s]));
  for (const scene of after.scenes) {
    if (!scene.quote) continue;
    const prev = prevScenes.get(scene.id);
    const media = scene.layers.find((l) => l.kind === "video" && l.slot === "media");
    const prevMedia = prev?.layers.find((l) => l.kind === "video" && l.slot === "media");
    const unchanged = prev?.quote && isDeepStrictEqual(prev.quote, scene.quote) && isDeepStrictEqual(prevMedia, media) && prev.durationFrames === scene.durationFrames;
    if (unchanged) continue;
    if (actor === "assistant") throw new AppError(403, "quote_locked", "Quotes come from the recordings and can only be changed by you.");
    const q = scene.quote;
    const fail = (why: string) => {
      throw new AppError(422, "quote_integrity", `Quote “${q.text.slice(0, 40)}…” ${why}`);
    };
    const t = await getTranscript(db, q.transcriptId, workspaceId).catch(() => null);
    if (!t) fail("refers to a transcript that isn't available.");
    if (t!.assetId !== q.assetId) fail("doesn't match its recording.");
    const idx = q.segmentIds.map((id) => t!.segments.findIndex((s) => s.id === id));
    if (idx.some((i) => i < 0)) fail("refers to transcript text that doesn't exist.");
    if (idx.some((v, i) => i > 0 && v !== idx[i - 1]! + 1)) fail("skips part of what was said; select a continuous passage.");
    const segs = idx.map((i) => t!.segments[i]!);
    const text = segs.map((s) => s.text.trim()).join(" ");
    if (norm(text) !== norm(q.text)) fail("differs from what was actually said.");
    if (Math.abs(segs[0]!.startSec - q.speechInSec) > EPS || Math.abs(segs.at(-1)!.endSec - q.speechOutSec) > EPS) fail("has timings that don't match the transcript.");
    const prevSeg = t!.segments[idx[0]! - 1];
    const nextSeg = t!.segments[idx.at(-1)! + 1];
    if (q.clipInSec > q.speechInSec + EPS || q.clipOutSec < q.speechOutSec - EPS) fail("would cut off words at its edges.");
    if (prevSeg && q.clipInSec < prevSeg.endSec - EPS) fail("starts inside the previous sentence.");
    if (nextSeg && q.clipOutSec > nextSeg.startSec + EPS) fail("runs into the next sentence.");
    if (!media || media.kind !== "video" || media.assetId !== q.assetId || media.muted) fail("must play its own recording with sound.");
    if (media!.kind === "video" && (Math.abs(media!.sourceInSec - q.clipInSec) > EPS || media!.sourceOutSec === null || Math.abs(media!.sourceOutSec - q.clipOutSec) > EPS)) fail("must play exactly its selected range.");
    const fps = after.format.fps;
    if (Math.abs(scene.durationFrames - Math.round((q.clipOutSec - q.clipInSec) * fps)) > 1) fail("must be as long as its clip (quotes are never trimmed).");
  }
  if (actor === "assistant" && before) {
    const quoteScenes = new Set(after.scenes.filter((s) => s.quote).map((s) => s.id));
    const pick = (d: ProjectDocument) => d.captions.cues.filter((c) => c.anchor.type === "scene" && quoteScenes.has(c.anchor.sceneId));
    if (!isDeepStrictEqual(pick(before), pick(after))) throw new AppError(403, "quote_locked", "Captions of quotes follow the recording and can only be changed by you.");
  }
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
