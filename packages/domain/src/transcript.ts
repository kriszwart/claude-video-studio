/**
 * Transcript-first editing helpers (FR-13/FR-14). Pure functions over transcript
 * segments: subtitle parsing, phrase-occurrence lookup, cut proposals and beat mapping.
 * The source transcript is immutable; corrections are an overlay keyed by segment id.
 */
import type { EditorialBeat, ProjectDocument } from "./document";
import { mapSourceRange } from "./program";

export interface TranscriptWord {
  text: string;
  startSec: number;
  endSec: number;
}

export interface TranscriptSegment {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string;
  /** Word timings when the provider supplies them; otherwise positions are estimated. */
  words?: TranscriptWord[];
}

export type TimingPrecision = "word" | "segment";

// ---------------------------------------------------------------------------------------
// Subtitle parsing (SRT / WebVTT). Tolerant of BOMs, CRLF, cue settings and inline tags.

function parseStamp(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1] ?? 0);
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, "0")) / 1000;
}

export function parseSubtitles(input: string): Omit<TranscriptSegment, "id">[] {
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const blocks = text.split(/\n{2,}/);
  const out: Omit<TranscriptSegment, "id">[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length);
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx < 0) continue;
    const [a, rest] = lines[idx]!.split("-->");
    const b = rest!.trim().split(/\s+/)[0]!;
    const start = parseStamp(a!);
    const end = parseStamp(b);
    if (start === null || end === null || end <= start) continue;
    const body = lines
      .slice(idx + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\{\\[^}]*\}/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!body) continue;
    const sp = /^([A-Z][\w .'-]{0,30}):\s+(.*)$/.exec(body);
    out.push({ startSec: start, endSec: end, text: sp ? sp[2]! : body, ...(sp ? { speaker: sp[1] } : {}) });
  }
  return out.sort((x, y) => x.startSec - y.startSec);
}

// ---------------------------------------------------------------------------------------
// Words and phrase lookup.

export function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}']+/gu, "");
}

export function tokens(text: string): string[] {
  return text.split(/\s+/).map(normalizeWord).filter(Boolean);
}

/** Word timings for a segment: provider words when present, else char-proportional estimates. */
export function segmentWords(seg: TranscriptSegment): { words: TranscriptWord[]; precision: TimingPrecision } {
  if (seg.words?.length) return { words: seg.words, precision: "word" };
  const raw = seg.text.split(/\s+/).filter(Boolean);
  const weights = raw.map((w) => Math.max(1, w.length) + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const dur = seg.endSec - seg.startSec;
  let t = seg.startSec;
  const words = raw.map((w, i) => {
    const d = (weights[i]! / total) * dur;
    const out = { text: w, startSec: t, endSec: t + d };
    t += d;
    return out;
  });
  return { words, precision: "segment" };
}

export interface PhraseOccurrence {
  occurrence: number;
  segmentId: string;
  startSec: number;
  endSec: number;
  precision: TimingPrecision;
  context: string;
}

/** Every occurrence of `phrase` (case/punctuation-insensitive, word-aligned), in time order. */
export function findPhraseOccurrences(segments: TranscriptSegment[], phrase: string): PhraseOccurrence[] {
  const want = tokens(phrase);
  if (!want.length) return [];
  const flat: { w: TranscriptWord; norm: string; seg: TranscriptSegment; precision: TimingPrecision }[] = [];
  for (const seg of segments) {
    const { words, precision } = segmentWords(seg);
    for (const w of words) {
      const norm = normalizeWord(w.text);
      if (norm) flat.push({ w, norm, seg, precision });
    }
  }
  const out: PhraseOccurrence[] = [];
  for (let i = 0; i + want.length <= flat.length; i++) {
    if (want.every((t, k) => flat[i + k]!.norm === t)) {
      const first = flat[i]!;
      const last = flat[i + want.length - 1]!;
      const ctx = flat
        .slice(Math.max(0, i - 6), i + want.length + 6)
        .map((x) => x.w.text)
        .join(" ");
      out.push({
        occurrence: out.length + 1,
        segmentId: first.seg.id,
        startSec: first.w.startSec,
        endSec: last.w.endSec,
        precision: first.precision === "word" && last.precision === "word" ? "word" : "segment",
        context: ctx,
      });
    }
  }
  return out;
}

/** Apply text corrections (segment id → corrected text). Word timings of corrected segments are dropped. */
export function correctedSegments(segments: TranscriptSegment[], corrections: Record<string, string> | undefined): TranscriptSegment[] {
  if (!corrections || !Object.keys(corrections).length) return segments;
  return segments.map((s) => (corrections[s.id] !== undefined && corrections[s.id] !== s.text ? { ...s, text: corrections[s.id]!, words: undefined } : s));
}

// ---------------------------------------------------------------------------------------
// Cut proposals. Silence requires BOTH audio inactivity and absence of transcript speech.

export interface SilenceInterval {
  startSec: number;
  endSec: number;
}

export interface CutProposal {
  id: string;
  sourceInSec: number;
  sourceOutSec: number;
  kind: "silence" | "mistake" | "filler";
  reason: string;
  context: string;
}

export interface CutOptions {
  durationSec: number;
  /** Speech kept around each cut (sentence handles). */
  handlesMs: number;
  /** Minimum removable pause after handles. */
  minSilenceSec: number;
  newId: (prefix: string) => string;
}

const FILLERS = new Set(["um", "uh", "erm", "er", "ah", "uhm", "hmm", "mm"]);
const NEGATIONS = new Set(["not", "no", "never", "don't", "doesn't", "didn't", "isn't", "wasn't", "can't", "won't", "shouldn't", "without", "nor"]);

function overlap(a0: number, a1: number, b0: number, b1: number) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  // Longest common prefix share + bag overlap: retakes usually restart the same sentence.
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  const bag = new Map<string, number>();
  for (const t of b) bag.set(t, (bag.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of a) {
    const n = bag.get(t) ?? 0;
    if (n > 0) {
      common++;
      bag.set(t, n - 1);
    }
  }
  return Math.max(p / Math.min(a.length, b.length), common / a.length);
}

/**
 * Propose silence, filler and retake removals (FR-13). Every proposal stays in the
 * review list; callers decide whether a project policy auto-accepts silence/fillers.
 * Retakes are never auto-accepted and include surrounding context for choosing a take.
 */
export function proposeCuts(segments: TranscriptSegment[], silences: SilenceInterval[], opts: CutOptions): CutProposal[] {
  const h = opts.handlesMs / 1000;
  const out: CutProposal[] = [];
  const segs = [...segments].sort((a, b) => a.startSec - b.startSec);
  const toks = segs.map((s) => tokens(s.text));

  // Fillers: a segment made only of filler tokens.
  const fillerIdx = new Set<number>();
  segs.forEach((s, i) => {
    if (toks[i]!.length && toks[i]!.every((t) => FILLERS.has(t))) fillerIdx.add(i);
  });

  // Retakes: segment i restarts as a later segment j (within 3), and j is at least as complete.
  const retakeIdx = new Map<number, number>();
  segs.forEach((_, i) => {
    if (fillerIdx.has(i) || toks[i]!.length < 3) return;
    for (let j = i + 1; j < Math.min(segs.length, i + 4); j++) {
      if (fillerIdx.has(j)) continue;
      if (segs[j]!.startSec - segs[i]!.endSec > 8) break;
      if (toks[j]!.length >= toks[i]!.length && similarity(toks[i]!, toks[j]!) >= 0.7) {
        retakeIdx.set(i, j);
        break;
      }
    }
  });

  for (const [i, j] of retakeIdx) {
    const a = segs[i]!;
    const b = segs[j]!;
    const negA = toks[i]!.filter((t) => NEGATIONS.has(t));
    const negB = toks[j]!.filter((t) => NEGATIONS.has(t));
    const meaning = negA.join() !== negB.join() ? " The takes differ in negation — check which one you meant before accepting." : "";
    const prev = segs[i - 1]?.text ?? "";
    out.push({
      id: opts.newId("cut"),
      sourceInSec: Math.max(0, a.startSec - h / 2),
      sourceOutSec: Math.min(opts.durationSec, b.startSec - h),
      kind: "mistake",
      reason: `Likely false start: "${a.text}" is repeated as "${b.text}".${meaning}`,
      context: `${prev ? `…${prev} ` : ""}[${a.text}] … ${b.text}`.slice(0, 600),
    });
  }

  const covered = (s: number, e: number) => out.some((c) => overlap(s, e, c.sourceInSec, c.sourceOutSec) > 0.5 * (e - s));
  for (const i of fillerIdx) {
    const s = segs[i]!;
    const prevEnd = segs[i - 1]?.endSec ?? 0;
    const nextStart = segs[i + 1]?.startSec ?? opts.durationSec;
    const from = Math.max(prevEnd + h, s.startSec - 0.05);
    const to = Math.min(nextStart - h, s.endSec + 0.05);
    if (to - from < 0.15 || covered(from, to)) continue;
    out.push({ id: opts.newId("cut"), sourceInSec: from, sourceOutSec: to, kind: "filler", reason: `Filler words only: "${s.text}".`, context: `${segs[i - 1]?.text ?? ""} [${s.text}] ${segs[i + 1]?.text ?? ""}`.trim().slice(0, 600) });
  }

  // Silence: audio-silent intervals that contain no transcript speech. Handles keep breaths
  // and sentence tails; a transcript gap with audible sound (music, applause) is never cut.
  for (const sil of silences) {
    // Subtitle boundaries are loose, so silence may eat into a segment's padded edges. It
    // conflicts with the transcript when it sits inside a segment (a mid-sentence pause) or
    // swallows a whole segment (transcribed speech the audio gate did not hear).
    const speech = segs.some((s) => (sil.startSec > s.startSec + 0.05 && sil.endSec < s.endSec - 0.05) || (sil.startSec <= s.startSec && sil.endSec >= s.endSec));
    if (speech) continue;
    const from = sil.startSec + h;
    const to = sil.endSec - h;
    if (to - from < opts.minSilenceSec) continue;
    if (covered(from, to)) continue;
    const before = [...segs].reverse().find((s) => s.endSec <= sil.startSec + 0.1);
    const after = segs.find((s) => s.startSec >= sil.endSec - 0.1);
    out.push({
      id: opts.newId("cut"),
      sourceInSec: from,
      sourceOutSec: to,
      kind: "silence",
      reason: `${(sil.endSec - sil.startSec).toFixed(1)} s pause with no speech in audio or transcript (keeps ${Math.round(h * 1000)} ms handles).`,
      context: `${before ? `…${before.text}` : "(start)"} ⏸ ${after ? `${after.text}…` : "(end)"}`.slice(0, 600),
    });
  }
  return out.sort((a, b) => a.sourceInSec - b.sourceInSec);
}

/**
 * Silence intervals from ffmpeg `silencedetect` stderr. Kept here so the parsing is
 * unit-tested without running ffmpeg.
 */
export function parseSilenceDetect(stderr: string, durationSec: number): SilenceInterval[] {
  const out: SilenceInterval[] = [];
  let start: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && start !== null) {
      out.push({ startSec: start, endSec: Number(e[1]) });
      start = null;
    }
  }
  if (start !== null && durationSec > start) out.push({ startSec: start, endSec: durationSec });
  return out;
}

// ---------------------------------------------------------------------------------------
// Beats: resolve each editorial beat's cue to a transcript occurrence and output frame.

export interface BeatResolution {
  beatId: string;
  status: EditorialBeat["status"];
  occurrences: PhraseOccurrence[];
  sourceStartSec?: number;
  sourceEndSec?: number;
  outputFrame?: number;
  message: string;
}

/**
 * Re-resolve beats against the (corrected) transcript and current EDL. A beat whose stored
 * source time no longer matches its phrase is flagged "changed"; a phrase that is absent is
 * "missing"; a phrase whose utterance was cut is reported, never silently moved.
 */
export function resolveBeats(doc: Pick<ProjectDocument, "program" | "format" | "beats">, segments: TranscriptSegment[]): BeatResolution[] {
  return doc.beats.map((beat) => {
    const occ = findPhraseOccurrences(segments, beat.cue.phrase);
    if (!occ.length) return { beatId: beat.id, status: "missing", occurrences: occ, message: `"${beat.cue.phrase}" is not in the transcript.` };
    const pick = occ[beat.cue.occurrence - 1];
    if (!pick) return { beatId: beat.id, status: "missing", occurrences: occ, message: `Only ${occ.length} occurrence(s) of "${beat.cue.phrase}"; occurrence ${beat.cue.occurrence} does not exist.` };
    const moved = beat.cue.sourceStartSec !== undefined && Math.abs(beat.cue.sourceStartSec - pick.startSec) > 0.35;
    const out = keptStart(doc, pick.startSec, pick.endSec);
    if (out === null) {
      return { beatId: beat.id, status: "changed", occurrences: occ, sourceStartSec: pick.startSec, sourceEndSec: pick.endSec, message: `The utterance "${beat.cue.phrase}" (#${pick.occurrence}) was cut from the edit.` };
    }
    return {
      beatId: beat.id,
      status: moved && beat.status === "mapped" ? "changed" : "mapped",
      occurrences: occ,
      sourceStartSec: pick.startSec,
      sourceEndSec: pick.endSec,
      outputFrame: out,
      message: moved ? `"${beat.cue.phrase}" moved after a transcript edit; now at ${pick.startSec.toFixed(2)} s.` : `Occurrence ${pick.occurrence} of ${occ.length} at ${pick.startSec.toFixed(2)} s (${pick.precision} timing).`,
    };
  });
}

/**
 * Output frame where a source utterance [start, end] begins, or null when its speech was
 * cut. Subtitle/estimated timings are padded, so a removed pause may trim the utterance's
 * lead-in: the start then snaps to the next kept frame as long as most of it survives.
 */
export function keptStart(doc: Pick<ProjectDocument, "program" | "format">, startSec: number, endSec: number): number | null {
  const r = mapSourceRange(doc, startSec, endSec);
  if (!r) return null;
  const fps = doc.format.fps;
  const keptSec = (r.end - r.start) / fps;
  // Kept output length can exceed nothing but the source length; require half the utterance.
  if (keptSec < 0.5 * Math.max(0, endSec - startSec) - 1 / fps) return null;
  return r.start;
}

/** Apply resolutions to the document's beats (does not touch anchors or locks). */
export function withResolvedBeats<T extends Pick<ProjectDocument, "beats">>(doc: T, res: BeatResolution[]): T["beats"] {
  return doc.beats.map((b) => {
    const r = res.find((x) => x.beatId === b.id);
    if (!r) return b;
    return {
      ...b,
      status: r.status === "changed" && r.outputFrame !== undefined ? "mapped" : r.status,
      cue: { ...b.cue, ...(r.sourceStartSec !== undefined ? { sourceStartSec: r.sourceStartSec, sourceEndSec: r.sourceEndSec } : {}) },
      outputFrame: r.outputFrame,
    };
  });
}

// ---------------------------------------------------------------------------------------
// Sections: split a talk into scenes at explicit step markers, else by duration.

const STEP_MARKERS = /^(first|second|third|fourth|fifth|next|then|finally|lastly|step \w+|that's it|in summary|to recap)\b/i;

export interface TranscriptSection {
  startSec: number;
  endSec: number;
  segmentIds: string[];
  text: string;
  /** Marker-based sections are "step"; the lead-in is "intro"; the tail after "that's it" is "outro". */
  kind: "intro" | "step" | "outro" | "body";
}

export function sectionsFromTranscript(segments: TranscriptSegment[], durationSec: number, opts: { maxSections?: number; targetSec?: number } = {}): TranscriptSection[] {
  const maxSections = opts.maxSections ?? 8;
  const segs = [...segments].sort((a, b) => a.startSec - b.startSec);
  if (!segs.length) return [{ startSec: 0, endSec: durationSec, segmentIds: [], text: "", kind: "body" }];
  const starts: number[] = [0];
  segs.forEach((s, i) => {
    if (i > 0 && STEP_MARKERS.test(s.text.trim())) starts.push(i);
  });
  if (starts.length < 2) {
    // No explicit steps: group by target duration at segment boundaries.
    const target = opts.targetSec ?? Math.max(6, durationSec / Math.min(maxSections, 4));
    let acc = segs[0]!.startSec;
    segs.forEach((s, i) => {
      if (i > 0 && s.startSec - acc >= target) {
        starts.push(i);
        acc = s.startSec;
      }
    });
  }
  const uniq = [...new Set(starts)].slice(0, maxSections);
  const hasMarkers = uniq.slice(1).some((i) => STEP_MARKERS.test(segs[i]!.text.trim()));
  return uniq.map((si, k) => {
    const ei = k + 1 < uniq.length ? uniq[k + 1]! : segs.length;
    const group = segs.slice(si, ei);
    const startSec = k === 0 ? 0 : (segs[si - 1]!.endSec + segs[si]!.startSec) / 2;
    const endSec = k + 1 < uniq.length ? (segs[ei - 1]!.endSec + segs[ei]!.startSec) / 2 : durationSec;
    const first = group[0]?.text.trim() ?? "";
    const kind: TranscriptSection["kind"] = !hasMarkers ? "body" : k === 0 ? "intro" : /^(that's it|in summary|to recap|finally)/i.test(first) && k === uniq.length - 1 ? "outro" : "step";
    return { startSec, endSec, segmentIds: group.map((g) => g.id), text: group.map((g) => g.text).join(" "), kind };
  });
}

/** Short takeaway line for a section: its most informative sentence, markers stripped. */
export function takeaway(text: string, maxChars = 60): string {
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const scored = sentences
    .map((s) => ({ s, n: tokens(s).filter((t) => !FILLERS.has(t)).length }))
    .filter((x) => x.n >= 3)
    .sort((a, b) => b.n - a.n);
  let best = (scored[0]?.s ?? sentences[0] ?? "").replace(/^(first|second|third|fourth|fifth|next|then|finally|lastly),?\s*/i, "");
  best = best.charAt(0).toUpperCase() + best.slice(1);
  if (best.length <= maxChars) return best.replace(/[.]$/, "");
  const cut = best.slice(0, maxChars);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

// ---------------------------------------------------------------------------------------
// Captions from the (corrected) transcript, timed in SOURCE seconds so the EDL maps them.

export function programCaptionCues(
  segments: TranscriptSegment[],
  sourceAssetId: string,
  opts: { maxWords: number; maxChars: number },
): import("./document").CaptionCue[] {
  const out: import("./document").CaptionCue[] = [];
  for (const seg of segments) {
    const { words, precision } = segmentWords(seg);
    let i = 0;
    let k = 0;
    while (i < words.length) {
      const chunk: TranscriptWord[] = [];
      let len = 0;
      while (i < words.length && chunk.length < opts.maxWords && (chunk.length === 0 || len + words[i]!.text.length + 1 <= opts.maxChars)) {
        len += words[i]!.text.length + 1;
        chunk.push(words[i]!);
        i++;
        if (/[.!?]$/.test(chunk.at(-1)!.text) && chunk.length >= 2) break;
      }
      const text = chunk.map((w) => w.text).join(" ");
      out.push({
        id: `cue_${seg.id}_${k++}`.slice(0, 64),
        text,
        anchor: { type: "source", assetId: sourceAssetId, startSec: chunk[0]!.startSec, endSec: chunk.at(-1)!.endSec },
        startFrame: 0,
        endFrame: 1,
        timing: precision === "word" ? "word" : "segment",
      });
    }
  }
  return out;
}
