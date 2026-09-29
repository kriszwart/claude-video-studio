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
