import type { CaptionCue, ProjectDocument } from "./document";
import { computeTimeline, resolveCaptions } from "./timeline";

/**
 * Draft quality review (FR-18): deterministic document-level checks and scoped repairs.
 * Repairs only move timing or layout of existing content; they never rewrite text, claims or
 * quotes, and never touch locked scenes.
 */
export interface QualityIssue {
  code: string;
  severity: "hard" | "creative";
  message: string;
  sceneId?: string;
  layerId?: string;
  cueId?: string;
  /** Composition time (seconds) where the problem shows, for evidence frames. */
  atSec?: number;
  repairable: boolean;
}

export function cueIssues(doc: ProjectDocument): QualityIssue[] {
  const tl = computeTimeline(doc);
  const fps = doc.format.fps;
  const out: QualityIssue[] = [];
  const scenes = new Map(doc.scenes.map((s, i) => [s.id, { scene: s, t: tl.scenes[i]! }]));
  for (const cue of doc.captions.cues) {
    if (cue.anchor.type !== "scene") continue;
    const sc = scenes.get(cue.anchor.sceneId);
    if (!sc) {
      out.push({ code: "cue_orphan", severity: "creative", message: `Caption “${cue.text.slice(0, 40)}” belongs to a deleted scene and never shows.`, cueId: cue.id, repairable: false });
      continue;
    }
    const localEnd = cue.anchor.offsetFrames + cue.endFrame;
    if (localEnd > sc.scene.durationFrames + 1) {
      out.push({ code: "cue_overruns_scene", severity: "creative", message: `Caption “${cue.text.slice(0, 40)}” runs ${((localEnd - sc.scene.durationFrames) / fps).toFixed(2)} s past the end of “${sc.scene.purpose}”, over the next scene.`, cueId: cue.id, sceneId: sc.scene.id, atSec: (sc.t.start + sc.scene.durationFrames) / fps, repairable: !sc.scene.locked });
    }
  }
  const resolved = resolveCaptions(doc, tl).sort((a, b) => a.start - b.start);
  for (let i = 1; i < resolved.length; i++) {
    const prev = resolved[i - 1]!;
    const cur = resolved[i]!;
    if (cur.start < prev.end - 1) {
      out.push({ code: "cue_overlap", severity: "creative", message: `Captions “${prev.cue.text.slice(0, 30)}” and “${cur.cue.text.slice(0, 30)}” overlap by ${((prev.end - cur.start) / fps).toFixed(2)} s.`, cueId: prev.cue.id, atSec: cur.start / fps, repairable: prev.cue.anchor.type !== "source" });
    }
  }
  return out;
}

/** Clamp overrunning scene cues and trim overlaps (earlier cue ends where the next starts). */
export function repairCues(doc: ProjectDocument, issues: QualityIssue[]): { cues: CaptionCue[]; fixed: string[] } {
  const cues = structuredClone(doc.captions.cues);
  const fixed: string[] = [];
  const tl = computeTimeline(doc);
  const sceneLen = new Map(doc.scenes.map((s) => [s.id, s]));
  for (const iss of issues.filter((i) => i.repairable && i.cueId)) {
    const cue = cues.find((c) => c.id === iss.cueId);
    if (!cue || cue.anchor.type !== "scene") continue;
    const scene = sceneLen.get(cue.anchor.sceneId);
    if (!scene || scene.locked) continue;
    if (iss.code === "cue_overruns_scene") {
      const maxEnd = scene.durationFrames - cue.anchor.offsetFrames;
      if (cue.startFrame >= maxEnd - 1) continue; // nothing sensible to keep: leave for review
      cue.endFrame = maxEnd;
      fixed.push(iss.cueId!);
    } else if (iss.code === "cue_overlap") {
      const resolved = resolveCaptions({ ...doc, captions: { ...doc.captions, cues } }, tl).sort((a, b) => a.start - b.start);
      const idx = resolved.findIndex((r) => r.cue.id === cue.id);
      const next = resolved[idx + 1];
      if (!next) continue;
      const base = resolved[idx]!.start - cue.startFrame;
      const newEnd = next.start - base;
      if (newEnd <= cue.startFrame + 1) continue;
      cue.endFrame = newEnd;
      fixed.push(iss.cueId!);
    }
  }
  return { cues, fixed };
}
