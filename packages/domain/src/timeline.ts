import type { AudioAnchor, AudioTrack, CaptionCue, ProjectDocument, Scene } from "./document";
import { mapSourceRange } from "./program";

export interface SceneTiming {
  sceneId: string;
  index: number;
  /** Absolute start frame (inclusive). */
  start: number;
  /** Absolute end frame (exclusive). */
  end: number;
  duration: number;
  /** Frames overlapping the previous scene. */
  overlapIn: number;
}

export interface Timeline {
  fps: number;
  totalFrames: number;
  scenes: SceneTiming[];
}

/**
 * Total duration = sum(scene durations) − sum(transition overlaps).
 * The first scene never overlaps; a cut never overlaps.
 */
export function computeTimeline(doc: Pick<ProjectDocument, "scenes" | "format">): Timeline {
  const scenes: SceneTiming[] = [];
  let cursor = 0;
  doc.scenes.forEach((scene, index) => {
    const overlapIn = effectiveOverlap(scene, index, doc.scenes[index - 1]);
    const start = Math.max(0, cursor - overlapIn);
    const end = start + scene.durationFrames;
    scenes.push({ sceneId: scene.id, index, start, end, duration: scene.durationFrames, overlapIn });
    cursor = end;
  });
  return { fps: doc.format.fps, totalFrames: cursor, scenes };
}

export function effectiveOverlap(scene: Scene, index: number, previous: Scene | undefined): number {
  if (index === 0 || !previous) return 0;
  if (scene.transitionIn.type === "cut") return 0;
  return scene.transitionIn.durationFrames;
}

export function sceneTiming(timeline: Timeline, sceneId: string): SceneTiming | undefined {
  return timeline.scenes.find((s) => s.sceneId === sceneId);
}

/** Absolute frame for an anchored item, or null when its scene no longer exists. */
export function resolveAnchor(anchor: AudioAnchor, timeline: Timeline): number | null {
  if (anchor.type === "absolute") return anchor.startFrame;
  const s = sceneTiming(timeline, anchor.sceneId);
  return s ? s.start + anchor.offsetFrames : null;
}

export interface ResolvedAudio {
  track: AudioTrack;
  startFrame: number;
  /** Frames the clip occupies on the timeline (clamped to the timeline end). */
  durationFrames: number;
}

/**
 * Resolve audio placement. `mediaDurationSec` gives probed source durations so
 * a clip never claims more time than its media holds.
 */
export function resolveAudio(
  doc: ProjectDocument,
  timeline: Timeline,
  mediaDurationSec: (assetId: string) => number | undefined,
): ResolvedAudio[] {
  const out: ResolvedAudio[] = [];
  for (const track of doc.audio) {
    const start = resolveAnchor(track.anchor, timeline);
    if (start === null || start >= timeline.totalFrames) continue;
    const mediaDur = mediaDurationSec(track.assetId);
    const srcOut = track.sourceOutSec ?? mediaDur ?? Number.POSITIVE_INFINITY;
    const availableSec = Math.max(0, srcOut - track.sourceInSec);
    let frames = Number.isFinite(availableSec) ? Math.floor(availableSec * timeline.fps) : timeline.totalFrames - start;
    frames = Math.min(frames, timeline.totalFrames - start);
    if (frames <= 0) continue;
    out.push({ track, startFrame: start, durationFrames: frames });
  }
  return out;
}

export interface ResolvedCue {
  cue: CaptionCue;
  start: number;
  end: number;
}

export function resolveCaptions(doc: ProjectDocument, timeline: Timeline): ResolvedCue[] {
  const cues: ResolvedCue[] = [];
  for (const cue of doc.captions.cues) {
    if (cue.anchor.type === "source") {
      // Source-timed cue: map through the EDL; cues whose speech was cut disappear.
      const r = mapSourceRange(doc, cue.anchor.startSec, cue.anchor.endSec);
      if (r && r.end > r.start) cues.push({ cue, start: r.start, end: Math.min(r.end, timeline.totalFrames) });
      continue;
    }
    const base = resolveAnchor(cue.anchor, timeline);
    if (base === null) continue;
    const start = base + cue.startFrame;
    const end = Math.min(base + cue.endFrame, timeline.totalFrames);
    if (end > start) cues.push({ cue, start, end });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export interface TimelineIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  sceneId?: string;
  layerId?: string;
  trackId?: string;
}

export interface ValidationLimits {
  maxOutputFrames: number;
  /** Narration speaking rate used for fit estimates when no audio has been generated. */
  wordsPerSecond: number;
}

export const DEFAULT_LIMITS: ValidationLimits = { maxOutputFrames: 5 * 60 * 30, wordsPerSecond: 2.6 };

/** Pre-render validation (FR-05). Errors block rendering; warnings are surfaced. */
export function validateTimeline(
  doc: ProjectDocument,
  opts: { limits?: ValidationLimits; mediaDurationSec?: (assetId: string) => number | undefined; knownAssetIds?: Set<string> } = {},
): TimelineIssue[] {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const issues: TimelineIssue[] = [];
  const ids = new Set<string>();
  const timeline = computeTimeline(doc);

  doc.scenes.forEach((scene, i) => {
    if (ids.has(scene.id)) issues.push({ severity: "error", code: "duplicate_scene_id", message: `Duplicate scene id ${scene.id}`, sceneId: scene.id });
    ids.add(scene.id);
    const prev = doc.scenes[i - 1];
    if (i === 0 && scene.transitionIn.type !== "cut" && scene.transitionIn.durationFrames > 0) {
      issues.push({ severity: "warning", code: "first_scene_transition", message: "The first scene's transition has nothing to overlap and is ignored.", sceneId: scene.id });
    }
    if (prev && scene.transitionIn.type !== "cut") {
      const o = scene.transitionIn.durationFrames;
      if (o >= scene.durationFrames || o >= prev.durationFrames) {
        issues.push({ severity: "error", code: "transition_too_long", message: `Transition into "${scene.purpose}" (${o} frames) must be shorter than both neighbouring scenes.`, sceneId: scene.id });
      }
    }
    const layerIds = new Set<string>();
    for (const layer of scene.layers) {
      if (layerIds.has(layer.id)) issues.push({ severity: "error", code: "duplicate_layer_id", message: `Duplicate layer id ${layer.id}`, sceneId: scene.id, layerId: layer.id });
      layerIds.add(layer.id);
      if ((layer.kind === "image" || layer.kind === "video") && !layer.hidden) {
        if (!layer.assetId) {
          issues.push({ severity: "warning", code: "missing_asset", message: `Scene "${scene.purpose}" has an empty ${layer.kind} slot "${layer.slot}".`, sceneId: scene.id, layerId: layer.id });
        } else if (opts.knownAssetIds && !opts.knownAssetIds.has(layer.assetId)) {
          issues.push({ severity: "error", code: "unknown_asset", message: `Asset ${layer.assetId} is not available to this project.`, sceneId: scene.id, layerId: layer.id });
        }
      }
      if (layer.kind === "text" && layer.text.trim().length === 0 && !layer.hidden) {
        issues.push({ severity: "warning", code: "empty_text", message: `Scene "${scene.purpose}" has empty ${layer.role} text.`, sceneId: scene.id, layerId: layer.id });
      }
      if (layer.kind === "text" && layer.animation.delayFrames >= scene.durationFrames) {
        issues.push({ severity: "error", code: "animation_after_scene", message: `Text "${layer.text.slice(0, 30)}" starts after its scene ends.`, sceneId: scene.id, layerId: layer.id });
      }
    }
    // Narration fit: prefer measured audio, otherwise estimate from word count.
    const narration = scene.script.narration.trim();
    if (narration) {
      const vo = doc.audio.find((t) => t.kind === "voiceover" && t.anchor.type === "scene" && t.anchor.sceneId === scene.id);
      const measured = vo ? opts.mediaDurationSec?.(vo.assetId) : undefined;
      const seconds = measured ?? narration.split(/\s+/).length / limits.wordsPerSecond;
      const offset = vo && vo.anchor.type === "scene" ? vo.anchor.offsetFrames : 0;
      const needed = Math.ceil(seconds * doc.format.fps) + offset;
      if (needed > scene.durationFrames) {
        issues.push({
          severity: "warning",
          code: "narration_overflow",
          message: `Narration for "${scene.purpose}" needs ~${(needed / doc.format.fps).toFixed(1)}s but the scene is ${(scene.durationFrames / doc.format.fps).toFixed(1)}s${measured === undefined ? " (estimated)" : ""}. Shorten the text, extend the scene, or raise the speech rate.`,
          sceneId: scene.id,
        });
      }
    }
  });

  if (timeline.totalFrames > limits.maxOutputFrames) {
    issues.push({ severity: "error", code: "too_long", message: `Timeline is ${(timeline.totalFrames / doc.format.fps).toFixed(1)}s; the limit is ${(limits.maxOutputFrames / doc.format.fps).toFixed(0)}s.` });
  }

  const sceneIds = new Set(doc.scenes.map((s) => s.id));
  for (const t of doc.audio) {
    if (t.anchor.type === "scene" && !sceneIds.has(t.anchor.sceneId)) {
      issues.push({ severity: "warning", code: "orphan_audio", message: `Audio track ${t.id} is anchored to a deleted scene and will not play.`, trackId: t.id });
    }
    if (t.sourceOutSec !== null && t.sourceOutSec <= t.sourceInSec) {
      issues.push({ severity: "error", code: "bad_trim", message: `Audio track ${t.id} ends before it starts.`, trackId: t.id });
    }
    if (opts.knownAssetIds && !opts.knownAssetIds.has(t.assetId)) {
      issues.push({ severity: "error", code: "unknown_asset", message: `Audio asset ${t.assetId} is not available.`, trackId: t.id });
    }
  }
  // Music lock: the selected excerpt must not be cut short (or padded with silence) silently.
  if (doc.musicLock.enabled) {
    const t = doc.audio.find((x) => x.id === doc.musicLock.trackId);
    if (t && t.sourceOutSec !== null) {
      const start = resolveAnchor(t.anchor, timeline) ?? 0;
      const need = start + Math.round((t.sourceOutSec - t.sourceInSec) * doc.format.fps);
      if (need > timeline.totalFrames + 1) issues.push({ severity: "warning", code: "music_truncated", message: `The timeline ends ${((need - timeline.totalFrames) / doc.format.fps).toFixed(1)} s before the selected music excerpt. Extend the scenes or choose a shorter excerpt.`, trackId: t.id });
      if (need < timeline.totalFrames - 1) issues.push({ severity: "warning", code: "music_short", message: `The video runs ${((timeline.totalFrames - need) / doc.format.fps).toFixed(1)} s past the selected music excerpt.`, trackId: t.id });
    }
  }
  for (const r of resolveCaptions(doc, timeline)) {
    if (r.cue.text.length > 90) {
      issues.push({ severity: "warning", code: "caption_long", message: `Caption "${r.cue.text.slice(0, 30)}…" is long and may wrap beyond two lines.` });
    }
  }
  return issues;
}
