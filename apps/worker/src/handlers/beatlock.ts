import { AppError, applyProjectOperations, getDb, getProject, JobError } from "@vs/db";
import { planBeatLock } from "@vs/domain";
import type { Handler } from "../context";
import { musicAnalysisFor } from "./music";

/**
 * Lock to the beat: analyse the music (cached on the asset), start the song so its drop lands on
 * the payoff, move the cuts onto beats, and refresh the timeline markers. One undoable edit.
 */
export const lockToMusic: Handler = async (ctx) => {
  const db = getDb();
  const projectId = ctx.job.projectId!;
  const { doc } = await getProject(db, projectId, ctx.job.workspaceId);
  const trackId = (ctx.job.input.trackId as string | undefined) ?? doc.audio.find((t) => t.kind === "music")?.id;
  const track = doc.audio.find((t) => t.id === trackId);
  if (!track) throw new JobError("invalid_input", "Add a music track first.", false, "Choose music in the Audio tab.");
  await ctx.stage("analysing tempo, beats and sections");
  const { analysis } = await musicAnalysisFor(ctx.job.workspaceId, track.assetId);
  if (analysis.tempoConfidence < 0.15 || analysis.beats.length < 8) throw new JobError("no_beat", `This music has no steady beat to lock to (tempo confidence ${analysis.tempoConfidence}).`, false, "Use a track with a clear beat, or place cuts by hand.");
  await ctx.stage("placing the drop and the cuts");
  for (let attempt = 0; attempt < 3; attempt++) {
    const { doc: cur, revision } = await getProject(db, projectId, ctx.job.workspaceId);
    const plan = planBeatLock(cur, analysis, { trackId: track.id, payoffSceneId: ctx.job.input.payoffSceneId as string | undefined });
    try {
      await db.transaction((tx) => applyProjectOperations(tx, { projectId, workspaceId: ctx.job.workspaceId, baseRevisionId: revision.id, ops: plan.ops, actor: "system", author: "system", action: `locked to the beat (${plan.report.cutsMoved} cuts moved)` }));
      return { ...plan.report, bpm: analysis.bpm, payoffScene: cur.scenes.find((s) => s.id === plan.report.payoff.sceneId)?.purpose ?? "", payoffSec: plan.report.payoff.frame / cur.format.fps };
    } catch (e) {
      if (!(e instanceof AppError && e.status === 409)) throw e;
    }
  }
  throw new JobError("stale_revision", "The project kept changing while it was locked to the beat; try again.", false);
};
