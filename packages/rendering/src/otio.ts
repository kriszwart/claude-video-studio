import { computeTimeline, resolveAudio, type ProjectDocument } from "@vs/domain";

/**
 * OpenTimelineIO export (Phase 4): the project as an editorial timeline for Resolve, Premiere or
 * any OTIO-aware tool. V1 is the rendered program cut at every scene boundary (transitions are
 * already baked in), so the edit reproduces the render exactly and each scene can be re-timed or
 * replaced. Source footage, voiceover and music sit on their own tracks at the positions the
 * renderer uses; music markers become timeline markers. Scene text and narration travel as
 * metadata. Media paths are relative (an .otioz bundle carries the files under media/).
 */

type Json = Record<string, unknown>;
const rt = (value: number, rate: number): Json => ({ OTIO_SCHEMA: "RationalTime.1", rate, value });
const range = (start: number, duration: number, rate: number): Json => ({ OTIO_SCHEMA: "TimeRange.1", start_time: rt(start, rate), duration: rt(duration, rate) });
const ref = (target: string, availableFrames: number | null, rate: number): Json => ({
  OTIO_SCHEMA: "ExternalReference.1",
  target_url: target,
  available_range: availableFrames === null ? null : range(0, availableFrames, rate),
  available_image_bounds: null,
  metadata: {},
  name: "",
});
const clip = (name: string, source: Json, target: string, availableFrames: number | null, rate: number, metadata: Json = {}): Json => ({
  OTIO_SCHEMA: "Clip.2",
  name,
  source_range: source,
  media_references: { DEFAULT_MEDIA: ref(target, availableFrames, rate) },
  active_media_reference_key: "DEFAULT_MEDIA",
  effects: [],
  markers: [],
  enabled: true,
  metadata,
});
const gap = (frames: number, rate: number): Json => ({ OTIO_SCHEMA: "Gap.1", name: "", source_range: range(0, frames, rate), effects: [], markers: [], enabled: true, metadata: {} });
const track = (name: string, kind: "Video" | "Audio", children: Json[]): Json => ({ OTIO_SCHEMA: "Track.1", name, kind, children, source_range: null, effects: [], markers: [], enabled: true, metadata: {} });

export interface OtioMedia {
  /** Relative path of the rendered program (e.g. media/program.mp4). */
  program: { path: string; frames: number };
  /** Relative path and duration (seconds) per asset id used on the timeline. */
  assets: Record<string, { path: string; durationSec: number | null }>;
}

/** Place clips on as few sequential lanes as possible (OTIO tracks cannot overlap). */
function lanes<T extends { start: number; frames: number }>(items: T[]): T[][] {
  const out: T[][] = [];
  for (const it of [...items].sort((a, b) => a.start - b.start)) {
    const lane = out.find((l) => l.at(-1)!.start + l.at(-1)!.frames <= it.start);
    if (lane) lane.push(it);
    else out.push([it]);
  }
  return out;
}

function sequence<T extends { start: number; frames: number }>(items: T[], rate: number, toClip: (it: T) => Json): Json[] {
  const children: Json[] = [];
  let cursor = 0;
  for (const it of items) {
    if (it.start > cursor) children.push(gap(it.start - cursor, rate));
    children.push(toClip(it));
    cursor = it.start + it.frames;
  }
  return children;
}

export function buildOtio(doc: ProjectDocument, media: OtioMedia, meta: { projectId: string; revisionId: string; width: number; height: number }): Json {
  const tl = computeTimeline(doc);
  const fps = doc.format.fps;
  const total = Math.min(tl.totalFrames, media.program.frames || tl.totalFrames);

  // V1: the program cut at scene boundaries.
  const cuts = tl.scenes.map((s, i) => ({ i, start: s.start, frames: (tl.scenes[i + 1]?.start ?? total) - s.start })).filter((c) => c.frames > 0 && c.start < total);
  const v1 = cuts.map((c) => {
    const scene = doc.scenes[c.i]!;
    return clip(`${c.i + 1}. ${scene.purpose}`, range(c.start, Math.min(c.frames, total - c.start), fps), media.program.path, media.program.frames, fps, {
      video_studio: {
        sceneId: scene.id,
        purpose: scene.purpose,
        layout: scene.layout,
        transitionIn: scene.transitionIn.type,
        onScreen: scene.layers.filter((l) => l.kind === "text" && !l.hidden).map((l) => (l.kind === "text" ? l.text : "")),
        narration: scene.script.narration,
        ...(scene.script.direction ? { voiceDirection: scene.script.direction } : {}),
      },
    });
  });

  // V2+: source footage used in scenes, from each scene's start for as long as the scene lasts.
  const footage = doc.scenes.flatMap((s, i) =>
    s.layers
      .filter((l) => l.kind === "video" && !l.hidden && l.assetId && media.assets[l.assetId])
      .map((l) => {
        const v = l as Extract<typeof l, { kind: "video" }>;
        const a = media.assets[v.assetId!]!;
        const srcFrames = a.durationSec ? Math.floor(a.durationSec * fps) : null;
        const inF = Math.round(v.sourceInSec * fps);
        const outF = v.sourceOutSec !== null ? Math.round(v.sourceOutSec * fps) : (srcFrames ?? inF + s.durationFrames);
        return { start: tl.scenes[i]!.start, frames: Math.max(1, Math.min(s.durationFrames, outF - inF)), inF, a, name: `${i + 1}. ${s.purpose} — footage`, srcFrames };
      }),
  );
  const videoTracks = [track("Program", "Video", sequence(v1.map((c, k) => ({ start: cuts[k]!.start, frames: cuts[k]!.frames, c })), fps, (x) => x.c))];
  lanes(footage).forEach((lane, k) => videoTracks.push(track(`Footage ${k + 1}`, "Video", sequence(lane, fps, (f) => clip(f.name, range(f.inF, f.frames, fps), f.a.path, f.srcFrames, fps)))));

  // Audio: voiceover, music and other sound, each on its own lanes, where the renderer places them.
  const placed = resolveAudio(doc, tl, (id) => media.assets[id]?.durationSec ?? undefined).filter((p) => media.assets[p.track.assetId]);
  const audioTracks: Json[] = [];
  for (const [kind, label] of [["voiceover", "Voiceover"], ["music", "Music"], ["source", "Source audio"], ["sfx", "Effects"]] as const) {
    const items = placed.filter((p) => p.track.kind === kind).map((p) => ({ start: p.startFrame, frames: p.durationFrames, p }));
    lanes(items).forEach((lane, k) =>
      audioTracks.push(
        track(`${label}${k ? ` ${k + 1}` : ""}`, "Audio", sequence(lane, fps, ({ p, frames }) => {
          const a = media.assets[p.track.assetId]!;
          const scene = p.track.anchor.type === "scene" ? doc.scenes.find((s) => s.id === (p.track.anchor as { sceneId: string }).sceneId) : undefined;
          return clip(scene ? `${label}: ${scene.purpose}` : label, range(Math.round(p.track.sourceInSec * fps), frames, fps), a.path, a.durationSec ? Math.floor(a.durationSec * fps) : null, fps, { video_studio: { trackId: p.track.id, gainDb: p.track.gainDb, fadeInFrames: p.track.fadeInFrames, fadeOutFrames: p.track.fadeOutFrames, ...(kind === "music" ? { duck: p.track.duck } : {}) } });
        })),
      ),
    );
  }

  const markers = doc.markers
    .filter((m) => m.frame < total)
    .map((m) => ({ OTIO_SCHEMA: "Marker.2", name: m.label || m.kind, marked_range: range(m.frame, 0, fps), color: m.kind === "section" ? "RED" : m.kind === "downbeat" ? "ORANGE" : "YELLOW", comment: m.verified ? "verified" : "proposed by analysis", metadata: { video_studio: { kind: m.kind } } }));

  return {
    OTIO_SCHEMA: "Timeline.1",
    name: doc.title,
    global_start_time: rt(0, fps),
    tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", children: [...videoTracks, ...audioTracks], source_range: null, effects: [], markers, enabled: true, metadata: {} },
    metadata: { video_studio: { projectId: meta.projectId, revisionId: meta.revisionId, title: doc.title, aspect: doc.format.aspect, fps, width: meta.width, height: meta.height, durationFrames: total } },
  };
}
