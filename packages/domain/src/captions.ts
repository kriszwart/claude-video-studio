import type { ProjectDocument } from "./document";
import { computeTimeline, resolveCaptions } from "./timeline";

function stamp(frames: number, fps: number, sep: "," | "."): string {
  const ms = Math.round((frames / fps) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
}

/** SRT export of the resolved (timeline-mapped) caption cues. */
export function toSrt(doc: ProjectDocument): string {
  const fps = doc.format.fps;
  return resolveCaptions(doc, computeTimeline(doc))
    .map((c, i) => `${i + 1}\n${stamp(c.start, fps, ",")} --> ${stamp(c.end, fps, ",")}\n${c.cue.text.replace(/\n+/g, " ")}\n`)
    .join("\n");
}

export function toVtt(doc: ProjectDocument): string {
  const fps = doc.format.fps;
  const body = resolveCaptions(doc, computeTimeline(doc))
    .map((c) => `${stamp(c.start, fps, ".")} --> ${stamp(c.end, fps, ".")}\n${c.cue.text.replace(/\n+/g, " ")}\n`)
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

/**
 * Split narration into readable caption chunks and time them across the measured
 * narration duration, proportionally to characters. This is honest segment-level
 * timing ("estimated"): it never claims word-level precision it does not have.
 */
export function captionChunks(text: string, maxWords = 6, maxChars = 42): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const chunks: string[] = [];
  let cur: string[] = [];
  for (const w of words) {
    const next = [...cur, w].join(" ");
    if (cur.length && (cur.length >= maxWords || next.length > maxChars)) {
      chunks.push(cur.join(" "));
      cur = [w];
    } else cur.push(w);
    if (/[.!?]$/.test(w) && cur.length >= 2) {
      chunks.push(cur.join(" "));
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur.join(" "));
  return chunks;
}

export function timeChunks(chunks: string[], startFrame: number, durationFrames: number): { text: string; startFrame: number; endFrame: number }[] {
  const total = chunks.reduce((a, c) => a + c.length + 1, 0);
  let cursor = startFrame;
  return chunks.map((text, i) => {
    const len = i === chunks.length - 1 ? startFrame + durationFrames - cursor : Math.max(8, Math.round(((text.length + 1) / total) * durationFrames));
    const cue = { text, startFrame: cursor, endFrame: cursor + Math.max(1, len) };
    cursor = cue.endFrame;
    return cue;
  });
}
