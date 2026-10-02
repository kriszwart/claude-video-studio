import { AppError, applyProjectOperations, getDb, getProject, getSoundKit, getStore, JobError, newId, saveSoundHit } from "@vs/db";
import { planSoundEffects, type Operation, type SoundKit } from "@vs/domain";
import { measureHit } from "@vs/rendering";
import type { Handler } from "../context";

/**
 * Place sound effects from the workspace's sound kit on the project's moments (transitions,
 * headlines landing, the call to action, typed text), each starting early by its measured hit so
 * the loud part lands on the moment. Effects placed before are replaced; tracks the owner added
 * by hand are kept.
 */
export const placeSoundEffects: Handler = async (ctx) => {
  const db = getDb();
  const density = ctx.job.input.density as "minimal" | "moderate" | "rich" | undefined;
  const entries = await getSoundKit(db, ctx.job.workspaceId);
  if (!entries.length) throw new JobError("sound_kit_empty", "Your sound kit is empty.", false, "Add a few short sounds (a whoosh, a pop, a chime…) under Audio → Sound kit first.");
  const kit: SoundKit = {};
  for (const e of entries) {
    let hit = e.hitSec;
    if (hit === null) {
      await ctx.stage(`measuring ${e.name}`);
      const h = await measureHit(await getStore().materialize(e.storageKey), ctx.signal);
      await saveSoundHit(db, e.assetId, { hitSec: h.hitSec, peakSec: h.peakSec });
      hit = h.hitSec;
    }
    kit[e.role] = { assetId: e.assetId, hitSec: hit, durationSec: e.durationSec };
  }
  await ctx.stage("placing effects");
  for (let attempt = 0; attempt < 3; attempt++) {
    const { doc, revision } = await getProject(db, ctx.job.projectId!, ctx.job.workspaceId);
    const plan = planSoundEffects(doc, kit, { density, newId: () => newId("trk") });
    const ops: Operation[] = [...doc.audio.filter((t) => t.sfx).map((t): Operation => ({ op: "removeAudioTrack", trackId: t.id })), ...plan.tracks.map((track): Operation => ({ op: "addAudioTrack", track }))];
    if (!ops.length) return { placed: 0, removed: 0, skipped: plan.skipped };
    try {
      await db.transaction((tx) => applyProjectOperations(tx, { projectId: ctx.job.projectId!, workspaceId: ctx.job.workspaceId, baseRevisionId: revision.id, ops, actor: "system", author: "system", action: `sound effects: ${plan.tracks.length} placed` }));
      return { placed: plan.tracks.length, removed: doc.audio.filter((t) => t.sfx).length, skipped: plan.skipped, roles: [...new Set(plan.tracks.map((t) => t.sfx!.role))] };
    } catch (e) {
      if (!(e instanceof AppError && e.status === 409)) throw e;
    }
  }
  throw new JobError("stale_revision", "The project kept changing while effects were placed; try again.", false);
};
