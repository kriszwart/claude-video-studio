import { eq } from "drizzle-orm";
import { AppError, applyProjectOperations, getDb, getProject, JobError, newId, replaceDocument, schema } from "@vs/db";
import { buildMusicVideoScenes } from "@vs/templates";
import { computeTimeline, type MusicMarker, type ProjectDocument } from "@vs/domain";
import { analyzeMusicFile, MUSIC_ANALYSIS_VERSION, type MusicAnalysis } from "@vs/rendering";
import { resolveAssets, type Handler } from "../context";

/** Analysis is a pure function of the audio: cache it on the immutable asset. */
export async function musicAnalysisFor(workspaceId: string, assetId: string): Promise<{ analysis: MusicAnalysis; cached: boolean }> {
  const db = getDb();
  const row = await db.query.assets.findFirst({ where: eq(schema.assets.id, assetId) });
  const cached = (row?.derived as { musicAnalysis?: MusicAnalysis } | undefined)?.musicAnalysis;
  if (cached?.version === MUSIC_ANALYSIS_VERSION) return { analysis: cached, cached: true };
  const file = (await resolveAssets(workspaceId, [assetId])).get(assetId)!;
  if (file.kind !== "audio" && !file.media.hasAudio) throw new JobError("invalid_input", "This file has no audio to analyse.", false);
  const analysis = await analyzeMusicFile(file.path);
  await db.update(schema.assets).set({ derived: { ...((row?.derived as object) ?? {}), musicAnalysis: analysis } }).where(eq(schema.assets.id, assetId));
  return { analysis, cached: false };
}

/**
 * Convert analysis (source-time) into project markers (absolute output frames) through the
 * music track's placement and trim. Owner-verified markers are kept; proposals replace
 * earlier unverified proposals only.
 */
export function markersFromAnalysis(doc: ProjectDocument, trackId: string, a: MusicAnalysis, density: "sections" | "downbeats" | "beats", newId: (p: string) => string): MusicMarker[] {
  const track = doc.audio.find((t) => t.id === trackId);
  if (!track) throw new JobError("invalid_input", "The music track no longer exists.", false);
  const tl = computeTimeline(doc);
  const start = track.anchor.type === "absolute" ? track.anchor.startFrame : (tl.scenes.find((s) => s.sceneId === (track.anchor as { sceneId: string }).sceneId)?.start ?? 0) + track.anchor.offsetFrames;
  const fps = doc.format.fps;
  const outOf = (sec: number) => {
    if (sec < track.sourceInSec - 1e-3 || (track.sourceOutSec !== null && sec > track.sourceOutSec + 1e-3)) return null;
    const f = start + Math.round((sec - track.sourceInSec) * fps);
    return f >= 0 && f < tl.totalFrames ? f : null;
  };
  const out: MusicMarker[] = doc.markers.filter((m) => m.verified);
  const taken = new Set(out.map((m) => `${m.kind}:${m.frame}`));
  const push = (sec: number, kind: MusicMarker["kind"], label: string) => {
    const f = outOf(sec);
    if (f === null || taken.has(`${kind}:${f}`)) return;
    taken.add(`${kind}:${f}`);
    out.push({ id: newId("mk"), frame: f, kind, label, verified: false });
  };
  for (const s of a.sections) push(s.startSec, "section", s.label);
  if (density !== "sections") for (const d of a.downbeats) push(d, "downbeat", "");
  if (density === "beats") for (const b of a.beats) push(b, "beat", "");
  return out.sort((x, y) => x.frame - y.frame).slice(0, 1000);
}

export const analyzeMusic: Handler = async (ctx) => {
  const db = getDb();
  const density = (ctx.job.input.density as "sections" | "downbeats" | "beats" | undefined) ?? "downbeats";
  let assetId = ctx.job.input.assetId as string | undefined;
  let trackId = ctx.job.input.trackId as string | undefined;
  if (ctx.job.projectId && !assetId) {
    const { doc } = await getProject(db, ctx.job.projectId, ctx.job.workspaceId);
    const t = trackId ? doc.audio.find((x) => x.id === trackId) : doc.audio.find((x) => x.kind === "music");
    if (!t) throw new JobError("invalid_input", "Add a music track before analysing it.", false);
    assetId = t.assetId;
    trackId = t.id;
  }
  if (!assetId) throw new JobError("invalid_input", "No audio selected.", false);
  await ctx.stage("analysing tempo, beats and sections");
  const { analysis, cached } = await musicAnalysisFor(ctx.job.workspaceId, assetId);
  const summary = { bpm: analysis.bpm, tempoConfidence: analysis.tempoConfidence, beats: analysis.beats.length, sections: analysis.sections, cached };
  if (!ctx.job.projectId) return summary;
  await ctx.stage(ctx.job.input.build === "music-video" ? "building section scenes" : "placing markers");
  for (let attempt = 0; attempt < 2; attempt++) {
    const { revision, doc } = await getProject(db, ctx.job.projectId, ctx.job.workspaceId);
    let next = doc;
    if (ctx.job.input.build === "music-video") {
      const track = doc.audio.find((t) => t.id === trackId)!;
      const lyricsRaw = doc.brief.inputs.lyrics;
      const lyrics = Array.isArray(lyricsRaw) ? lyricsRaw.map(String) : typeof lyricsRaw === "string" ? lyricsRaw.split("\n") : [];
      const motif = String(doc.brief.inputs.motif ?? "ring") as "ring" | "circle" | "blob" | "bars";
      next = buildMusicVideoScenes(doc, {
        sections: analysis.sections,
        excerpt: { inSec: track.sourceInSec, outSec: track.sourceOutSec ?? analysis.durationSec },
        songTitle: String(doc.brief.inputs.songTitle ?? doc.title),
        artist: String(doc.brief.inputs.artist ?? ""),
        motif: ["ring", "circle", "blob", "bars"].includes(motif) ? motif : "ring",
        lyrics,
        newId,
      });
    }
    const markers = markersFromAnalysis(next, trackId!, analysis, density, newId);
    if (next !== doc) {
      try {
        const rev = await db.transaction((tx) => replaceDocument(tx, { projectId: ctx.job.projectId!, workspaceId: ctx.job.workspaceId, baseRevisionId: revision.id, doc: { ...next, markers }, author: "system", action: `music video from analysis: ${analysis.bpm} BPM, ${analysis.sections.length} sections (markers unverified)` }));
        return { ...summary, revisionId: rev.id, markers: markers.length, scenes: next.scenes.length };
      } catch (e) {
        if (e instanceof AppError && e.status === 409 && attempt === 0) continue;
        throw e;
      }
    }
    const fit = Array.isArray(ctx.job.input.fit) ? (ctx.job.input.fit as ("section" | "downbeat" | "beat")[]) : [];
    try {
      const r = await db.transaction((tx) => applyProjectOperations(tx, { projectId: ctx.job.projectId!, workspaceId: ctx.job.workspaceId, baseRevisionId: revision.id, ops: [{ op: "setMarkers", markers }, ...(fit.length ? [{ op: "fitScenesToMarkers" as const, kinds: fit }] : [])], actor: "system", author: "system", action: `music analysis: ${analysis.bpm} BPM, ${analysis.sections.length} sections (unverified)` }));
      return { ...summary, revisionId: r.revision.id, markers: markers.length };
    } catch (e) {
      if (e instanceof AppError && e.status === 409 && attempt === 0) continue;
      throw e;
    }
  }
  throw new JobError("stale_revision", "The project kept changing; run the analysis again.", true);
};
