import { join } from "node:path";
import { AppError, applyProjectOperations, getDb, getProject, getProviderSecret, getProviderSettings, JobError, newId, releaseSpend, reserveSpend, settleSpend } from "@vs/db";
import { computeTimeline, type Operation } from "@vs/domain";
import { composeMusic, ElevenLabsError, ElevenLabsSettings, ElevenLabsTts, MUSIC_LIMITS, musicEstimate } from "@vs/providers";
import { registerFile, type Handler } from "../context";

/**
 * Generate a music bed with ElevenLabs Music (Phase 4) and put it on the timeline.
 * Paid: the request is reserved against the project budget first (a known owner-entered price,
 * or one authorised unknown-price request), settled after, released on failure. Runs once —
 * a failed job is never retried automatically, so a provider call is never paid for twice.
 */
export const generateMusic: Handler = async (ctx) => {
  const db = getDb();
  const input = ctx.job.input as { prompt: string; durationSec?: number; instrumental?: boolean; replace?: boolean };
  const projectId = ctx.job.projectId!;
  const key = await getProviderSecret(db, ctx.job.workspaceId, "elevenlabs");
  if (!key) throw new JobError("credentials_missing", "No ElevenLabs key is configured.", false, "Add your ElevenLabs key in Settings → Provider keys.");
  const settings = ElevenLabsSettings.parse(await getProviderSettings(db, ctx.job.workspaceId, "elevenlabs"));
  const { doc } = await getProject(db, projectId, ctx.job.workspaceId);
  const projectSec = computeTimeline(doc).totalFrames / doc.format.fps;
  const lengthSec = Math.round(Math.min(MUSIC_LIMITS.maxSec, Math.max(MUSIC_LIMITS.minSec, input.durationSec ?? Math.ceil(projectSec + 1))));

  const operationId = `${ctx.job.id}:music`;
  const reserved = await db.transaction((tx) => reserveSpend(tx, { workspaceId: ctx.job.workspaceId, projectId, jobId: ctx.job.id, operationId, provider: "elevenlabs", capability: "music-generation", estimate: musicEstimate(settings, lengthSec) }));
  if (!reserved.decision.allowed) {
    throw new JobError(reserved.decision.code, reserved.decision.message, false, reserved.decision.code === "unknown_price_unauthorized" ? "Authorise unknown-price requests in the project budget (Project tab), or enter your ElevenLabs music price in Settings." : "Raise the project budget, or attach your own music track.");
  }

  await ctx.stage("composing music");
  let file: string;
  try {
    file = (await composeMusic(new ElevenLabsTts(key.secret), input.prompt, lengthSec, join(ctx.workDir, "music"), { instrumental: input.instrumental !== false, modelId: settings.musicModel || undefined, signal: ctx.signal })).file;
  } catch (e) {
    await releaseSpend(db, ctx.job.workspaceId, operationId);
    if (e instanceof ElevenLabsError) {
      const recovery = { auth: "Check the ElevenLabs key in Settings.", quota: "Your ElevenLabs plan is out of credits for music; add credits or attach your own track.", rate_limited: "Wait a moment and try again.", unreachable: "Check your internet connection and try again.", server_error: "Try again in a moment.", unknown_voice: "" }[e.code];
      throw new JobError(`elevenlabs_${e.code}`, `ElevenLabs music: ${e.message}`, false, recovery);
    }
    throw e;
  }

  await ctx.stage("adding to the timeline");
  const asset = await registerFile(ctx.job.workspaceId, file, { kind: "audio", originalName: `music-${input.prompt.slice(0, 40).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "bed"}.mp3`, mime: "audio/mpeg", generated: true, provenance: { source: "elevenlabs-music", prompt: input.prompt, requestedSec: lengthSec, instrumental: input.instrumental !== false, model: settings.musicModel ?? "default", jobId: ctx.job.id, projectId } });
  await settleSpend(db, ctx.job.workspaceId, operationId, null);
  const measured = Number((asset.media as { durationSec?: number }).durationSec ?? 0);
  if (!measured) throw new JobError("music_invalid", "The generated music could not be read as audio.", false);

  const trackId = newId("trk");
  for (let attempt = 0; attempt < 4; attempt++) {
    const { revision, doc: cur } = await getProject(db, projectId, ctx.job.workspaceId);
    const ops: Operation[] = [
      ...(input.replace !== false ? cur.audio.filter((t) => t.kind === "music").map((t) => ({ op: "removeAudioTrack" as const, trackId: t.id })) : []),
      { op: "addAudioTrack", track: { id: trackId, kind: "music", assetId: asset.id, anchor: { type: "absolute", startFrame: 0 }, sourceInSec: 0, sourceOutSec: null, gainDb: -8, fadeInFrames: 15, fadeOutFrames: 45, duck: { enabled: true, amountDb: -12 } } },
    ];
    try {
      const r = await db.transaction((tx) => applyProjectOperations(tx, { projectId, workspaceId: ctx.job.workspaceId, baseRevisionId: revision.id, ops, actor: "system", author: "system", action: "music generated (ElevenLabs)" }));
      return { assetId: asset.id, trackId, revisionId: r.revision.id, requestedSec: lengthSec, measuredSec: Math.round(measured * 100) / 100, priced: reserved.decision.reserveMicros !== null };
    } catch (e) {
      if (!(e instanceof AppError && e.status === 409)) throw e;
    }
  }
  throw new JobError("stale_revision", "The project kept changing; the music is in your library but was not added. Add it from the Audio tab.", false);
};
