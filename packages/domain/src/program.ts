import type { EdlEntry, ProjectDocument } from "./document";

export interface MappedSegment {
  entry: EdlEntry;
  /** Output start frame (inclusive) and length in frames. */
  outStart: number;
  frames: number;
}

/**
 * Explicit source → output time map for a program (FR-13). Accepted EDL entries play
 * back to back; each boundary is rounded to whole frames once, here, so every consumer
 * (renderer, captions, beats, mixer) agrees on the same frames.
 */
export function programSegments(doc: Pick<ProjectDocument, "program" | "format">): MappedSegment[] {
  const p = doc.program;
  if (!p) return [];
  const fps = doc.format.fps;
  const out: MappedSegment[] = [];
  let cursor = 0;
  for (const entry of p.edl) {
    if (entry.review !== "accepted") continue;
    const frames = Math.round((entry.sourceOutSec - entry.sourceInSec) * fps);
    if (frames <= 0) continue;
    out.push({ entry, outStart: cursor, frames });
    cursor += frames;
  }
  return out;
}

export function programFrames(doc: Pick<ProjectDocument, "program" | "format">): number {
  const segs = programSegments(doc);
  const last = segs.at(-1);
  return last ? last.outStart + last.frames : 0;
}

/** Map a source time to an output frame; null when the moment was cut. */
export function sourceToOutput(doc: Pick<ProjectDocument, "program" | "format">, sec: number, opts: { snap?: "next" | "prev" | "none" } = {}): number | null {
  const fps = doc.format.fps;
  const segs = programSegments(doc);
  for (const s of segs) {
    if (sec >= s.entry.sourceInSec - 1e-6 && sec <= s.entry.sourceOutSec + 1e-6) {
      return Math.min(s.outStart + s.frames, s.outStart + Math.round((sec - s.entry.sourceInSec) * fps));
    }
  }
  if (opts.snap === "next") {
    const n = segs.find((s) => s.entry.sourceInSec > sec);
    return n ? n.outStart : null;
  }
  if (opts.snap === "prev") {
    const p = [...segs].reverse().find((s) => s.entry.sourceOutSec < sec);
    return p ? p.outStart + p.frames : null;
  }
  return null;
}

export function outputToSource(doc: Pick<ProjectDocument, "program" | "format">, frame: number): number | null {
  const fps = doc.format.fps;
  for (const s of programSegments(doc)) {
    if (frame >= s.outStart && frame < s.outStart + s.frames) return s.entry.sourceInSec + (frame - s.outStart) / fps;
  }
  return null;
}

/** Map a source range to output frames, clipped to kept material; null if fully cut. */
export function mapSourceRange(doc: Pick<ProjectDocument, "program" | "format">, startSec: number, endSec: number): { start: number; end: number } | null {
  const a = sourceToOutput(doc, startSec, { snap: "next" });
  const b = sourceToOutput(doc, endSec, { snap: "prev" });
  if (a === null || b === null || b <= a) return null;
  return { start: a, end: b };
}

/**
 * Re-derive program scene durations after cuts: each scene covers its source range, so
 * its output duration is the kept material inside that range. Returns a new document.
 */
export function syncProgramScenes<T extends ProjectDocument>(doc: T): T {
  if (!doc.program || !doc.scenes.every((s) => s.sourceRange)) return doc;
  const next = structuredClone(doc);
  const total = programFrames(next);
  let cursor = 0;
  next.scenes.forEach((s, i) => {
    const r = s.sourceRange!;
    const isLast = i === next.scenes.length - 1;
    const endFrame = isLast ? total : (sourceToOutput(next, r.endSec, { snap: "prev" }) ?? cursor);
    s.durationFrames = Math.max(1, endFrame - cursor);
    s.transitionIn = { type: "cut", durationFrames: 0 };
    cursor += s.durationFrames;
  });
  return next;
}
