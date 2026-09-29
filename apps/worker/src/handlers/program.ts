import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError, getDb, getProject, getProviderSecret, getTranscript, JobError, latestTranscriptForAsset, newId, replaceDocument, saveTranscript, applyProjectOperations } from "@vs/db";
import { correctedSegments, parseSilenceDetect, parseSubtitles, proposeCuts, type ProjectDocument, type TranscriptSegment } from "@vs/domain";
import { ElevenLabsStt, WhisperCppStt, type TranscriptionResult } from "@vs/providers";
import { FFMPEG, run } from "@vs/rendering";
import { buildProgramScenes } from "@vs/templates";
import { TemplateDefinition } from "@vs/templates";
import { resolveAssets, type Handler, type JobContext } from "../context";

type Provider = "auto" | "subtitle" | "elevenlabs" | "whisper-cpp";

async function runProvider(ctx: JobContext, provider: Provider, sourcePath: string, subtitlePath: string | null, language?: string): Promise<TranscriptionResult> {
  const db = getDb();
  if (provider === "subtitle" || (provider === "auto" && subtitlePath)) {
    if (!subtitlePath) throw new JobError("invalid_input", "Choose a subtitle file to import.", false);
    const segments = parseSubtitles(await readFile(subtitlePath, "utf8"));
    if (!segments.length) throw new JobError("invalid_subtitles", "No timed cues were found in the subtitle file.", false, "Upload an SRT or WebVTT file.");
    return { provider: "subtitle-import", language: language ?? null, granularity: "segment", segments };
  }
  const el = provider === "elevenlabs" || provider === "auto" ? await getProviderSecret(db, ctx.job.workspaceId, "elevenlabs") : null;
  if (el) {
    await ctx.stage("extracting audio");
    const audio = join(ctx.workDir, "speech.m4a");
    await run(FFMPEG, ["-hide_banner", "-nostdin", "-y", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k", audio], { timeoutMs: 600_000, signal: ctx.signal });
    await ctx.stage("transcribing with ElevenLabs");
    try {
      return await new ElevenLabsStt(el.secret).transcribe(audio, { language, signal: ctx.signal });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 403) throw new JobError("credentials_invalid", "ElevenLabs rejected the API key.", false, "Check the ElevenLabs key in Settings.");
      throw new JobError("provider_error", `Transcription failed: ${String((e as Error).message).slice(0, 200)}`, status === undefined || status >= 500 || status === 429);
    }
  }
  if (provider === "elevenlabs") throw new JobError("credentials_missing", "ElevenLabs is not configured.", false, "Add an ElevenLabs key in Settings, upload an SRT/VTT file, or configure local Whisper.");
  if ((provider === "whisper-cpp" || provider === "auto") && WhisperCppStt.available()) {
    await ctx.stage("transcribing locally (whisper.cpp)");
    return new WhisperCppStt().transcribe(sourcePath, { language, signal: ctx.signal, workDir: ctx.workDir } as never);
  }
  throw new JobError(
    "transcription_unavailable",
    "No transcription source is available.",
    false,
    "Upload the recording's subtitles (SRT or VTT), connect ElevenLabs speech-to-text in Settings, or set WHISPER_CPP_BIN and WHISPER_CPP_MODEL for local Whisper.",
  );
}

/** Build sections/captions/inserts for a project from its transcript; retried once on a concurrent edit. */
async function applyProgramBuild(ctx: JobContext, transcriptId: string, segments: TranscriptSegment[], durationSec: number) {
  const db = getDb();
  for (let attempt = 0; attempt < 2; attempt++) {
    const { revision, doc, project } = await getProject(db, ctx.job.projectId!, ctx.job.workspaceId);
    if (!doc.program) throw new JobError("invalid_input", "This project has no source recording.", false);
    const tv = await db.query.templateVersions.findFirst({ where: (t, { and, eq }) => and(eq(t.templateId, doc.template.templateId), eq(t.version, doc.template.version)) });
    const def = tv ? TemplateDefinition.safeParse(tv.definition) : null;
    const bRollInput = def?.success ? def.data.program?.bRollInput : undefined;
    const bRoll = bRollInput ? ([] as string[]).concat((doc.brief.inputs[bRollInput] as string[] | string | undefined) ?? []) : [];
    const withTranscript: ProjectDocument = { ...doc, program: { ...doc.program, transcriptId } };
    const next = buildProgramScenes(withTranscript, { segments: correctedSegments(segments, doc.program.corrections), sourceDurationSec: durationSec, newId, bRollAssetIds: bRoll, resetBeats: doc.beats.length === 0 });
    try {
      const rev = await db.transaction((tx) => replaceDocument(tx, { projectId: project.id, workspaceId: ctx.job.workspaceId, baseRevisionId: revision.id, doc: next, author: "system", action: "built sections and captions from transcript" }));
      return { revisionId: rev.id, scenes: next.scenes.length, cues: next.captions.cues.length, beats: next.beats.length };
    } catch (e) {
      if (e instanceof AppError && e.status === 409 && attempt === 0) continue;
      throw e;
    }
  }
  throw new JobError("stale_revision", "The project kept changing; run transcription again.", true);
}

/**
 * Transcribe a source recording (FR-13). The machine transcript is immutable and shared:
 * sibling variants of the same recording reuse it instead of transcribing again (A18).
 */
export const transcribe: Handler = async (ctx) => {
  const db = getDb();
  let assetId = ctx.job.input.assetId as string | undefined;
  if (!assetId && ctx.job.projectId) assetId = (await getProject(db, ctx.job.projectId, ctx.job.workspaceId)).doc.program?.sourceAssetId;
  if (!assetId) throw new JobError("invalid_input", "No recording to transcribe.", false);
  const subtitleAssetId = (ctx.job.input.subtitleAssetId as string | undefined) || undefined;
  const provider = (ctx.job.input.provider as Provider | undefined) ?? "auto";
  const ids = [assetId, ...(subtitleAssetId ? [subtitleAssetId] : [])];
  const assets = await resolveAssets(ctx.job.workspaceId, ids);
  const src = assets.get(assetId)!;
  const durationSec = src.media.durationSec ?? 0;
  if (!src.media.hasAudio) throw new JobError("no_audio", "The recording has no audio track to transcribe.", false);

  let transcriptId: string;
  let segments: TranscriptSegment[];
  let reused = false;
  let meta: { provider: string; granularity: string; language: string | null };
  const existing = !ctx.job.input.force && !subtitleAssetId ? await latestTranscriptForAsset(db, assetId, ctx.job.workspaceId) : null;
  if (existing) {
    await ctx.stage("reusing existing transcript");
    transcriptId = existing.id;
    segments = existing.segments;
    reused = true;
    meta = { provider: existing.provider, granularity: existing.granularity, language: existing.language };
  } else {
    const r = await runProvider(ctx, provider, src.path, subtitleAssetId ? assets.get(subtitleAssetId)!.path : null, ctx.job.input.language as string | undefined);
    const saved = await saveTranscript(db, { workspaceId: ctx.job.workspaceId, assetId, provider: r.provider, language: r.language, granularity: r.granularity, segments: r.segments.filter((s) => s.startSec < durationSec + 0.5) });
    transcriptId = saved.id;
    segments = saved.segments;
    meta = { provider: r.provider, granularity: r.granularity, language: r.language };
  }
  const build = ctx.job.projectId ? (await ctx.stage("building sections and captions"), await applyProgramBuild(ctx, transcriptId, segments, durationSec)) : null;
  return { transcriptId, reused, segments: segments.length, ...meta, build };
};

/**
 * Propose silence / filler / retake cuts (FR-13). Silence needs BOTH measured audio
 * inactivity and no transcript speech. Proposals go to the review list; only the
 * categories the owner authorised in the project's cleanup policy are auto-accepted.
 */
export const proposeProgramCuts: Handler = async (ctx) => {
  const db = getDb();
  const { revision, doc } = await getProject(db, ctx.job.projectId!, ctx.job.workspaceId);
  const p = doc.program;
  if (!p?.transcriptId) throw new JobError("invalid_input", "Transcribe the recording before proposing cuts.", false);
  const t = await getTranscript(db, p.transcriptId, ctx.job.workspaceId);
  const src = (await resolveAssets(ctx.job.workspaceId, [p.sourceAssetId])).get(p.sourceAssetId)!;
  const durationSec = src.media.durationSec ?? 0;
  const threshold = Number(ctx.job.input.silenceDb ?? -38);
  const minSilenceSec = Number(ctx.job.input.minSilenceSec ?? 0.5);
  await ctx.stage("measuring audio activity");
  const r = await run(FFMPEG, ["-hide_banner", "-nostdin", "-i", src.path, "-vn", "-af", `silencedetect=n=${threshold}dB:d=0.35`, "-f", "null", "-"], { timeoutMs: 600_000, signal: ctx.signal });
  const silences = parseSilenceDetect(r.stderr, durationSec);
  const cuts = proposeCuts(correctedSegments(t.segments, p.corrections), silences, { durationSec, handlesMs: p.handlesMs, minSilenceSec, newId });
  // Never re-propose material that was already removed.
  const kept = cuts.filter((c) => p.edl.some((e) => e.review === "accepted" && Math.min(e.sourceOutSec, c.sourceOutSec) - Math.max(e.sourceInSec, c.sourceInSec) > 0.1));
  const auto = kept.filter((c) => (c.kind === "silence" && p.cleanupPolicy.autoAcceptSilence) || (c.kind === "filler" && p.cleanupPolicy.autoAcceptFillers)).map((c) => c.id);
  await ctx.stage("saving proposals");
  const ops = [{ op: "proposeCuts" as const, cuts: kept }, ...(auto.length ? [{ op: "acceptCuts" as const, cutIds: auto }] : [])];
  const res = await db.transaction((tx) => applyProjectOperations(tx, { projectId: ctx.job.projectId!, workspaceId: ctx.job.workspaceId, baseRevisionId: revision.id, ops, actor: "system", author: "system", action: `proposed ${kept.length} cut(s)` }));
  const byKind = (k: string) => kept.filter((c) => c.kind === k).length;
  return { revisionId: res.revision.id, proposed: kept.length, silence: byKind("silence"), filler: byKind("filler"), mistake: byKind("mistake"), autoAccepted: auto.length, silencesMeasured: silences.length, thresholdDb: threshold };
};
