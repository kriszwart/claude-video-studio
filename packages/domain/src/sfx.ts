import type { AudioTrack, ProjectDocument } from "./document";
import { computeTimeline } from "./timeline";

/**
 * Sound effects from the owner's sound kit (real recordings), placed so each sound's measured
 * hit lands on the moment it belongs to: a transition, a headline landing, the call to action.
 * A sound's "hit" is where it first gets loud (a whoosh peaks late, a click hits at once), so a
 * sound starts `hitSec` before its moment. Pure: the worker measures the kit and applies the plan.
 */

export const SOUND_ROLES = ["whoosh", "pop", "click", "typing", "ding", "chime", "cash", "impact"] as const;
export type SoundRole = (typeof SOUND_ROLES)[number];

export const SOUND_ROLE_LABEL: Record<SoundRole, string> = {
  whoosh: "Whoosh (transitions)",
  pop: "Pop (headlines landing)",
  click: "Click (items, cursor clicks)",
  typing: "Typing (typed text)",
  ding: "Ding (steps, notifications)",
  chime: "Success chime (call to action)",
  cash: "Coin / cash (money moments)",
  impact: "Soft impact (big numbers, the drop)",
};

export interface KitSound {
  assetId: string;
  /** Seconds from the start of the file to where it first gets loud. */
  hitSec: number;
  durationSec: number;
}
export type SoundKit = Partial<Record<SoundRole, KitSound>>;

export interface SoundEvent {
  frame: number;
  role: SoundRole;
  /** What happens here, for the track list ("Scene 2: transition"). */
  label: string;
  /** Lower wins when two events are too close. */
  priority: number;
  /** For sounds that last as long as the action (typing). */
  holdFrames?: number;
}

/** Default levels: effects sit under voice and music. */
export const SOUND_GAIN_DB: Record<SoundRole, number> = { whoosh: -12, pop: -14, click: -12, typing: -16, ding: -12, chime: -10, cash: -10, impact: -8 };
/** Two effects closer than this crowd each other; the more important one stays. */
export const MIN_GAP_SEC = 0.3;
/** Longest tail kept from a one-shot sound. */
const MAX_TAIL_SEC = 2.5;

const WHOOSH_TRANSITIONS = new Set(["slide", "wipe", "zoom", "flythrough", "portal", "fold", "tiles", "colorfield", "liquid", "lens", "morph"]);

/** Moments in the video that can carry a sound, by density. */
export function soundEvents(doc: ProjectDocument, density: "minimal" | "moderate" | "rich" = doc.profile.soundDensity): SoundEvent[] {
  const tl = computeTimeline(doc);
  const fps = doc.format.fps;
  const out: SoundEvent[] = [];
  const noWhoosh = doc.profile.avoided.some((a) => /whoosh/i.test(a));
  doc.scenes.forEach((scene, i) => {
    const st = tl.scenes[i]!;
    const n = `Scene ${i + 1}`;
    // Transitions: the whoosh peaks where the move is fastest, a little past the middle.
    if (i > 0 && !noWhoosh && WHOOSH_TRANSITIONS.has(scene.transitionIn.type) && st.overlapIn > 0) out.push({ frame: st.start + Math.round(st.overlapIn * 0.6), role: "whoosh", label: `${n}: ${scene.transitionIn.type} transition`, priority: 1 });
    // Screen demo: a click on every press (one frame after the cursor arrives).
    for (const step of scene.demo?.steps ?? []) if (step.action === "click" && step.atFrames < st.duration) out.push({ frame: st.start + step.atFrames + 1, role: "click", label: `${n}: click${step.label ? ` “${step.label}”` : ""}`, priority: 2 });
    // Counting numbers: a coin on each stop it reaches, a soft impact on the last.
    for (const l of scene.layers) {
      if (l.hidden || l.kind !== "text" || !l.count) continue;
      l.count.stops.slice(1).forEach((s, k, rest) => {
        if (s.atFrames < st.duration) out.push({ frame: st.start + s.atFrames, role: k === rest.length - 1 ? "impact" : "cash", label: `${n}: number reaches ${s.value}`, priority: k === rest.length - 1 ? 1 : 3 });
      });
    }
    for (const l of scene.layers) {
      if (l.hidden || l.kind !== "text" || !l.text.trim() || l.count) continue;
      const at = st.start + l.animation.delayFrames;
      // Fast-in eases land almost at once; a pop overshoots at about a third of its move.
      const land = at + (l.animation.in === "pop" ? Math.round(fps * 0.15) : 2);
      if (l.animation.in === "none") continue;
      // The call to action is the payoff: its chime outranks the whoosh of a transition into it.
      if (l.role === "cta") out.push({ frame: land, role: "chime", label: `${n}: call to action`, priority: 0 });
      else if (l.role === "stat" && density !== "minimal") out.push({ frame: land, role: "impact", label: `${n}: number`, priority: 3 });
      else if (l.animation.in === "type" && density !== "minimal") out.push({ frame: at, role: "typing", label: `${n}: typed text`, priority: 5, holdFrames: Math.min(st.duration - l.animation.delayFrames, Math.round(l.text.length * 0.045 * fps) + 6) });
      else if ((l.role === "headline" || l.role === "quote") && density !== "minimal") out.push({ frame: land, role: "pop", label: `${n}: ${l.role} lands`, priority: 4 });
      else if ((l.role === "body" || l.role === "label" || l.role === "kicker") && density === "rich") out.push({ frame: land, role: "click", label: `${n}: ${l.role} appears`, priority: 6 });
    }
  });
  return out.sort((a, b) => a.frame - b.frame || a.priority - b.priority);
}

/**
 * The effect tracks for a document (pure). Events whose role has no sound in the kit are left
 * out; crowded events keep the most important one. Each track is anchored to the scene it starts
 * in, so it follows that scene when scenes move.
 */
export function planSoundEffects(doc: ProjectDocument, kit: SoundKit, opts: { density?: "minimal" | "moderate" | "rich"; newId: () => string }): { tracks: AudioTrack[]; skipped: { role: SoundRole; label: string; why: string }[] } {
  const fps = doc.format.fps;
  const tl = computeTimeline(doc);
  const events = soundEvents(doc, opts.density);
  const skipped: { role: SoundRole; label: string; why: string }[] = [];
  const kept: SoundEvent[] = [];
  for (const e of [...events].sort((a, b) => a.priority - b.priority || a.frame - b.frame)) {
    if (!kit[e.role]) {
      skipped.push({ role: e.role, label: e.label, why: "no sound for this role in the kit" });
      continue;
    }
    if (kept.some((k) => Math.abs(k.frame - e.frame) < MIN_GAP_SEC * fps)) {
      skipped.push({ role: e.role, label: e.label, why: "too close to a more important effect" });
      continue;
    }
    kept.push(e);
  }
  const tracks = kept
    .sort((a, b) => a.frame - b.frame)
    .map((e): AudioTrack => {
      const s = kit[e.role]!;
      // Start on the next frame boundary at or after (moment − hit) and trim the difference from
      // the file's start, so the hit lands on the moment to the millisecond, not the frame.
      const want = e.frame / fps - s.hitSec;
      const start = Math.max(0, Math.ceil(want * fps - 1e-9));
      const sourceInSec = Math.round((start / fps - want) * 1000) / 1000;
      const idx = Math.max(0, tl.scenes.findLastIndex((t) => t.start <= start));
      const scene = tl.scenes[idx]!;
      const tail = e.holdFrames ? e.holdFrames / fps + s.hitSec : MAX_TAIL_SEC;
      const out = Math.min(s.durationSec, sourceInSec + tail);
      return {
        id: opts.newId(),
        kind: "sfx",
        assetId: s.assetId,
        anchor: { type: "scene", sceneId: scene.sceneId, offsetFrames: start - scene.start },
        sourceInSec,
        sourceOutSec: out < s.durationSec - 0.01 ? Math.round(out * 1000) / 1000 : null,
        gainDb: SOUND_GAIN_DB[e.role],
        fadeInFrames: 0,
        fadeOutFrames: e.holdFrames ? 4 : 0,
        duck: { enabled: false, amountDb: -12 },
        sfx: { role: e.role, event: e.label },
      };
    });
  return { tracks, skipped };
}
