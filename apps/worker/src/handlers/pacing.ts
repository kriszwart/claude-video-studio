import { computeTimeline, type ProjectDocument, type QualityIssue } from "@vs/domain";
import { FFMPEG, run } from "@vs/rendering";
import { resolveAssets, type JobContext } from "../context";

/** Comfortable narration is roughly 2.3–3.0 words per second (140–180 wpm); brisk ads reach ~3.3. */
export const FAST_WPS = 3.5;
export const SLOW_WPS = 1.7;
export const LONG_PAUSE_SEC = 1.5;
export const LATE_START_SEC = 1.0;
/** Speech allowed to spill past a cut before it counts as running over. */
export const OVERRUN_GRACE_SEC = 0.15;

export interface VoiceFacts {
  sceneId: string;
  words: number;
  durationSec: number;
  /** Seconds from the first to the last word (pauses inside count, as in words-per-minute). */
  speechSec: number;
  wordsPerSec: number;
  leadingSilenceSec: number;
  longestPauseSec: number;
  /** Seconds the recording runs past the end of its scene (≤ 0 when it fits). */
  overrunSec: number;
}

/** Silences in an audio file: [start, end] pairs, measured by ffmpeg silencedetect. */
export async function silences(file: string, signal?: AbortSignal): Promise<[number, number][]> {
  const r = await run(FFMPEG, ["-hide_banner", "-nostdin", "-i", file, "-af", "silencedetect=n=-35dB:d=0.3", "-f", "null", "-"], { signal, timeoutMs: 120_000 });
  const out: [number, number][] = [];
  let start: number | null = null;
  for (const line of r.stderr.split("\n")) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (e && start !== null) {
      out.push([start, Number(e[1])]);
      start = null;
    }
  }
  return out;
}

/** Pacing facts from a recording's length, its silences and the scene it belongs to (pure). */
export function voiceFacts(sceneId: string, narration: string, durationSec: number, gaps: [number, number][], sceneSec: number, offsetSec: number): VoiceFacts {
  const words = narration.trim().split(/\s+/).filter(Boolean).length;
  const lead = gaps.find(([a]) => a <= 0.05);
  const leadingSilenceSec = lead ? lead[1] : 0;
  const trail = gaps.find(([, b]) => b >= durationSec - 0.05);
  const inner = gaps.filter((g) => g !== lead && g !== trail);
  const spokenEnd = trail ? trail[0] : durationSec;
  const speechSec = Math.max(0.1, spokenEnd - leadingSilenceSec);
  return {
    sceneId,
    words,
    durationSec,
    speechSec,
    wordsPerSec: Math.round((words / speechSec) * 100) / 100,
    leadingSilenceSec: Math.round(leadingSilenceSec * 100) / 100,
    longestPauseSec: Math.round(Math.max(0, ...inner.map(([a, b]) => b - a)) * 100) / 100,
    overrunSec: Math.round((offsetSec + spokenEnd - sceneSec) * 100) / 100,
  };
}

export function pacingIssues(doc: ProjectDocument, facts: VoiceFacts[]): QualityIssue[] {
  const tl = computeTimeline(doc);
  const fps = doc.format.fps;
  const out: QualityIssue[] = [];
  for (const f of facts) {
    const i = doc.scenes.findIndex((s) => s.id === f.sceneId);
    if (i < 0) continue;
    const scene = doc.scenes[i]!;
    const startSec = tl.scenes[i]!.start / fps;
    const name = `“${scene.purpose}”`;
    if (f.words >= 6 && f.wordsPerSec > FAST_WPS) out.push({ code: "voiceover_fast", severity: "creative", message: `The voiceover in ${name} is rushed: ${f.wordsPerSec.toFixed(1)} words a second (~${Math.round(f.wordsPerSec * 60)} wpm; comfortable is 2.3–3.0). Cut words, slow the voice, or give the scene more time.`, sceneId: scene.id, atSec: startSec, repairable: false });
    if (f.words >= 6 && f.wordsPerSec < SLOW_WPS) out.push({ code: "voiceover_slow", severity: "creative", message: `The voiceover in ${name} drags: ${f.wordsPerSec.toFixed(1)} words a second (~${Math.round(f.wordsPerSec * 60)} wpm). Raise the pace or tighten the line.`, sceneId: scene.id, atSec: startSec, repairable: false });
    if (f.longestPauseSec >= LONG_PAUSE_SEC) out.push({ code: "voiceover_pause", severity: "creative", message: `The voiceover in ${name} has a ${f.longestPauseSec.toFixed(1)} s silence mid-line. Re-record it, or trim the pause.`, sceneId: scene.id, atSec: startSec, repairable: false });
    if (f.leadingSilenceSec >= LATE_START_SEC) out.push({ code: "voiceover_late_start", severity: "creative", message: `The voiceover in ${name} starts ${f.leadingSilenceSec.toFixed(1)} s into the scene, leaving dead air. Trim its start.`, sceneId: scene.id, atSec: startSec, repairable: false });
    if (f.overrunSec > OVERRUN_GRACE_SEC) {
      const next = doc.scenes[i + 1];
      out.push({ code: "voiceover_overrun", severity: "creative", message: next ? `The voiceover in ${name} runs ${f.overrunSec.toFixed(1)} s past the cut into “${next.purpose}”. Make the scene at least ${(scene.durationFrames / fps + f.overrunSec + 0.3).toFixed(1)} s, or shorten the line.` : `The voiceover in ${name} runs ${f.overrunSec.toFixed(1)} s past the end of the video and is cut off. Make the scene at least ${(scene.durationFrames / fps + f.overrunSec + 0.3).toFixed(1)} s, or shorten the line.`, sceneId: scene.id, atSec: Math.max(0, (tl.scenes[i]!.start + scene.durationFrames) / fps - 0.2), repairable: false });
    }
  }
  return out;
}

/** Measure every narrated scene that has a recorded voiceover. */
export async function measureVoice(ctx: JobContext, doc: ProjectDocument): Promise<VoiceFacts[]> {
  const fps = doc.format.fps;
  const tracks = doc.audio.filter((t) => t.kind === "voiceover" && t.anchor.type === "scene");
  if (!tracks.length) return [];
  const files = await resolveAssets(ctx.job.workspaceId, [...new Set(tracks.map((t) => t.assetId))]);
  const out: VoiceFacts[] = [];
  for (const t of tracks) {
    if (t.anchor.type !== "scene") continue;
    const sceneId = t.anchor.sceneId;
    const scene = doc.scenes.find((s) => s.id === sceneId);
    const f = files.get(t.assetId);
    if (!scene || !f || !scene.script.narration.trim()) continue;
    const full = Number(f.media.durationSec ?? 0);
    if (!full) continue;
    // The part of the recording that plays (track trims).
    const inSec = t.sourceInSec, outSec = t.sourceOutSec ?? full;
    const gaps = (await silences(f.path, ctx.signal)).map(([a, b]) => [Math.max(0, a - inSec), Math.min(outSec, b) - inSec] as [number, number]).filter(([a, b]) => b > a);
    out.push(voiceFacts(sceneId, scene.script.narration, outSec - inSec, gaps, scene.durationFrames / fps, t.anchor.offsetFrames / fps));
  }
  return out;
}
