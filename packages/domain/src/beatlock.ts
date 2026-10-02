import type { MusicMarker, ProjectDocument, Scene } from "./document";
import type { Operation } from "./operations";
import { computeTimeline } from "./timeline";

/**
 * Lock a video to its music (pure). The song's drop (its biggest rise in energy between
 * sections) lands on the payoff moment: the song starts at whatever point makes that happen.
 * Every cut then moves to the nearest beat of the song as placed (whole beats, never stretching
 * time), with the payoff pinned, and the video ends on a beat.
 */

export interface SongGrid {
  durationSec: number;
  bpm: number;
  beats: number[];
  downbeats: number[];
  sections: { startSec: number; endSec: number; label: string; energy: number }[];
}

export interface BeatLockReport {
  drop: { sec: number; label: string; rise: number } | null;
  payoff: { sceneId: string; frame: number; why: string };
  /** Where in the song the video starts, and how long the video waits before the music starts. */
  songStartSec: number;
  musicDelaySec: number;
  cutsMoved: number;
  beatSec: number;
  conflicts: string[];
}

/** Below this rise (0–1 section energy) a song without a peak section has no clear drop. */
export const MIN_DROP_RISE = 0.2;
/** Scenes stay readable. */
const MIN_SCENE_SEC = 1.0;

/**
 * Drops: every section that arrives at (nearly) the song's peak energy from a quieter one, like
 * each chorus after a verse; without any, the clear rises between sections. In song order.
 */
export function dropCandidates(song: SongGrid): { sec: number; label: string; rise: number }[] {
  const s = song.sections;
  const max = Math.max(0, ...s.map((x) => x.energy));
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const peaks = s.flatMap((x, i) => (i > 0 && x.energy >= 0.9 * max && x.energy - s[i - 1]!.energy >= 0.05 ? [{ sec: x.startSec, label: x.label, rise: r2(x.energy - s[i - 1]!.energy) }] : []));
  if (peaks.length) return peaks;
  return s.flatMap((x, i) => (i > 0 && x.energy - s[i - 1]!.energy >= MIN_DROP_RISE ? [{ sec: x.startSec, label: x.label, rise: r2(x.energy - s[i - 1]!.energy) }] : []));
}

/** The song's first drop (see dropCandidates), or none. */
export function findDrop(song: SongGrid): { sec: number; label: string; rise: number } | null {
  return dropCandidates(song)[0] ?? null;
}

/**
 * The drop to use when the payoff is `payoffSec` into the video: the first one late enough in the
 * song that the music can start with the video (or within a second of it); if none is, the latest.
 */
export function chooseDrop(song: SongGrid, payoffSec: number): { sec: number; label: string; rise: number } | null {
  const c = dropCandidates(song);
  return c.find((d) => d.sec >= payoffSec - 1) ?? c.at(-1) ?? null;
}

/** The moment a scene pays off: a counter's last number, else its key line landing, else its start. */
export function payoffFrame(doc: ProjectDocument, sceneId: string): { frame: number; why: string } {
  const tl = computeTimeline(doc);
  const i = doc.scenes.findIndex((s) => s.id === sceneId);
  const scene = doc.scenes[i]!;
  const start = tl.scenes[i]!.start;
  const texts = scene.layers.filter((l) => l.kind === "text" && !l.hidden);
  const counter = texts.find((l) => l.kind === "text" && l.count);
  if (counter && counter.kind === "text" && counter.count) return { frame: start + counter.count.stops.at(-1)!.atFrames, why: "the number reaches its last value" };
  const key = texts.find((l) => l.kind === "text" && (l.role === "stat" || l.role === "quote" || l.role === "cta")) ?? texts.find((l) => l.kind === "text" && l.role === "headline");
  if (key && key.kind === "text") return { frame: start + key.animation.delayFrames + 2, why: `the ${key.role} lands` };
  return { frame: start, why: "the scene starts" };
}

/** Which scene carries the payoff when the owner hasn't chosen: a counter, then proof, a number, the call to action. */
export function payoffScene(doc: ProjectDocument): Scene {
  const has = (s: Scene, f: (l: Scene["layers"][number]) => boolean) => s.layers.some((l) => !l.hidden && f(l));
  return (
    doc.scenes.find((s) => has(s, (l) => l.kind === "text" && !!l.count)) ??
    doc.scenes.find((s) => s.recipeSlot === "proof") ??
    doc.scenes.find((s) => has(s, (l) => l.kind === "text" && l.role === "stat")) ??
    [...doc.scenes].reverse().find((s) => has(s, (l) => l.kind === "text" && l.role === "cta")) ??
    doc.scenes[Math.floor(doc.scenes.length / 2)]!
  );
}

export function planBeatLock(doc: ProjectDocument, song: SongGrid, opts: { trackId: string; payoffSceneId?: string }): { ops: Operation[]; markers: MusicMarker[]; report: BeatLockReport; newId?: never } & { durations: Record<string, number> } {
  const fps = doc.format.fps;
  const track = doc.audio.find((t) => t.id === opts.trackId);
  if (!track) throw new Error("The music track no longer exists.");
  const conflicts: string[] = [];
  const scene = opts.payoffSceneId ? doc.scenes.find((s) => s.id === opts.payoffSceneId) ?? payoffScene(doc) : payoffScene(doc);
  const p = doc.scenes.indexOf(scene);
  const tl0 = computeTimeline(doc);
  const pay = payoffFrame(doc, scene.id);
  const offsetInScene = pay.frame - tl0.scenes[p]!.start;
  const drop = chooseDrop(song, pay.frame / fps);
  const beatSec = 60 / song.bpm;

  // Song position at the payoff: the drop, or (no clear drop) the downbeat nearest where it plays now.
  const nowStart = track.anchor.type === "absolute" ? track.anchor.startFrame : 0;
  const nowAtPayoff = track.sourceInSec + (pay.frame - nowStart) / fps;
  const D = drop?.sec ?? song.downbeats.reduce((b, d) => (Math.abs(d - nowAtPayoff) < Math.abs(b - nowAtPayoff) ? d : b), song.downbeats[0] ?? nowAtPayoff);
  if (!drop) conflicts.push("The song has no clear drop, so the payoff lands on a downbeat instead.");

  // Snap cuts with the payoff pinned. X = song second at video frame 0 (may be negative: music waits).
  const X = D - pay.frame / fps;
  const grid = song.beats.map((b) => Math.round((b - X) * fps)).filter((f) => f >= 0);
  const snap = (f: number, lo: number, hi: number) => {
    let best: number | null = null;
    for (const g of grid) if (g >= lo && g <= hi && (best === null || Math.abs(g - f) < Math.abs(best - f))) best = g;
    return best;
  };
  const minLen = Math.round(MIN_SCENE_SEC * fps);
  const durations: Record<string, number> = Object.fromEntries(doc.scenes.map((s) => [s.id, s.durationFrames]));
  const starts = tl0.scenes.map((s) => s.start);
  const overlap = tl0.scenes.map((s) => s.overlapIn);
  const T = [...starts];
  const payStart = starts[p]!;
  // Before the payoff: each cut to its nearest beat, leaving room for the scenes up to the payoff.
  for (let i = 1; i < p; i++) {
    const prev = doc.scenes[i - 1]!;
    if (prev.locked) {
      T[i] = T[i - 1]! + durations[prev.id]! - overlap[i]!;
      continue;
    }
    const lo = T[i - 1]! + minLen - overlap[i]!, hi = payStart - minLen * (p - i) + overlap[p]!;
    const s = snap(starts[i]!, lo, hi);
    T[i] = s ?? Math.min(Math.max(starts[i]!, lo), hi);
  }
  T[p] = payStart;
  // After the payoff: snap in order; each change shifts what follows.
  for (let i = p + 1; i < doc.scenes.length; i++) {
    const prev = doc.scenes[i - 1]!;
    const natural = T[i - 1]! + durations[prev.id]! - overlap[i]!;
    if (prev.locked) {
      T[i] = natural;
      continue;
    }
    const s = snap(natural, T[i - 1]! + minLen - overlap[i]!, natural + Math.round(beatSec * fps));
    T[i] = s ?? natural;
  }
  for (let i = 1; i < doc.scenes.length; i++) {
    const prev = doc.scenes[i - 1]!;
    const d = T[i]! - T[i - 1]! + overlap[i]!;
    if (prev.locked) {
      if (d !== prev.durationFrames) conflicts.push(`“${prev.purpose}” is locked, so its cut stays where it is.`);
      continue;
    }
    durations[prev.id] = Math.max(minLen, d);
  }
  // End on a beat (not later than the song allows).
  const last = doc.scenes.at(-1)!;
  if (!last.locked) {
    const naturalEnd = T.at(-1)! + durations[last.id]!;
    const end = snap(naturalEnd, T.at(-1)! + minLen, naturalEnd + Math.round(beatSec * fps));
    if (end !== null) durations[last.id] = end - T.at(-1)!;
  }

  // Recompute where the payoff landed (locked scenes may have shifted it) and place the song there.
  const after = { ...doc, scenes: doc.scenes.map((s) => ({ ...s, durationFrames: durations[s.id]! })) };
  const tl1 = computeTimeline(after);
  const payFrame = tl1.scenes[p]!.start + offsetInScene;
  if (payFrame !== pay.frame) conflicts.push("A locked scene moved the payoff; the drop still lands on it, but some cuts may be off the beat.");
  const X1 = D - payFrame / fps;
  const delayFrames = X1 < 0 ? Math.round(-X1 * fps) : 0;
  const songStartSec = Math.max(0, Math.round(X1 * 1000) / 1000);
  const songLeft = song.durationSec - songStartSec - tl1.totalFrames / fps + delayFrames / fps;
  if (songLeft < 0) conflicts.push(`The song ends ${(-songLeft).toFixed(1)} s before the video does; it fades out early.`);
  if (delayFrames > 3 * fps) conflicts.push(`The drop comes early in the song, so the music starts ${(delayFrames / fps).toFixed(1)} s into the video.`);

  const ops: Operation[] = [];
  let cutsMoved = 0;
  for (const s of doc.scenes) {
    if (durations[s.id] !== s.durationFrames) {
      ops.push({ op: "setSceneDuration", sceneId: s.id, durationFrames: durations[s.id]! });
      cutsMoved++;
    }
  }
  ops.push({ op: "updateAudioTrack", trackId: track.id, patch: { anchor: { type: "absolute", startFrame: delayFrames }, sourceInSec: songStartSec, sourceOutSec: null } });

  // Markers for the timeline: downbeats and sections as placed, the drop on the payoff.
  const toFrame = (sec: number) => Math.round((sec - songStartSec) * fps) + delayFrames;
  const markers: MusicMarker[] = [];
  const seen = new Set<string>();
  const add = (frame: number, kind: MusicMarker["kind"], label: string) => {
    if (frame < 0 || frame >= tl1.totalFrames || seen.has(`${kind}:${frame}`)) return;
    seen.add(`${kind}:${frame}`);
    markers.push({ id: `mk_${kind[0]}${frame}`, frame, kind, label, verified: false });
  };
  for (const sct of song.sections) add(toFrame(sct.startSec), "section", drop && Math.abs(sct.startSec - drop.sec) < 1e-6 ? "drop" : sct.label);
  if (!drop) add(payFrame, "section", "payoff");
  for (const d of song.downbeats) add(toFrame(d), "downbeat", "");
  markers.sort((a, b) => a.frame - b.frame);
  ops.push({ op: "setMarkers", markers: [...doc.markers.filter((m) => m.verified), ...markers.filter((m) => !doc.markers.some((v) => v.verified && v.frame === m.frame && v.kind === m.kind))].sort((a, b) => a.frame - b.frame) });

  return { ops, markers, durations, report: { drop, payoff: { sceneId: scene.id, frame: payFrame, why: pay.why }, songStartSec, musicDelaySec: delayFrames / fps, cutsMoved, beatSec: Math.round(beatSec * 1000) / 1000, conflicts } };
}
