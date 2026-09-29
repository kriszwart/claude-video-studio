import type { TranscriptSegment, TranscriptWord } from "@vs/domain";

export interface TranscriptionResult {
  provider: string;
  language: string | null;
  /** "word" only when the engine returned measured word timings. */
  granularity: "word" | "segment";
  segments: Omit<TranscriptSegment, "id">[];
}

export interface TranscriptionProvider {
  id: string;
  kind: "local" | "hosted";
  transcribe(file: string, opts: { language?: string; signal?: AbortSignal }): Promise<TranscriptionResult>;
}

/** Group timed words into sentence-like segments (sentence end, long pause or length). */
export function groupWords(words: (TranscriptWord & { speaker?: string })[], opts: { maxGapSec?: number; maxChars?: number } = {}): Omit<TranscriptSegment, "id">[] {
  const maxGap = opts.maxGapSec ?? 0.7;
  const maxChars = opts.maxChars ?? 120;
  const out: Omit<TranscriptSegment, "id">[] = [];
  let cur: (TranscriptWord & { speaker?: string })[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ startSec: cur[0]!.startSec, endSec: cur.at(-1)!.endSec, text: cur.map((w) => w.text).join(" ").replace(/\s+([,.!?;:])/g, "$1"), words: cur.map(({ text, startSec, endSec }) => ({ text, startSec, endSec })), ...(cur[0]!.speaker ? { speaker: cur[0]!.speaker } : {}) });
    cur = [];
  };
  for (const w of words) {
    const prev = cur.at(-1);
    if (prev && (w.startSec - prev.endSec > maxGap || (w.speaker ?? "") !== (prev.speaker ?? "") || cur.map((x) => x.text).join(" ").length + w.text.length > maxChars)) flush();
    cur.push(w);
    if (/[.!?]["')\]]?$/.test(w.text)) flush();
  }
  flush();
  return out;
}
