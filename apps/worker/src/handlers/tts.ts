import { createHash } from "node:crypto";
import { join } from "node:path";
import { applyProjectOperations, AppError, getDb, getProject, getOmniVoiceConfig, getProviderSecret, JobError, newId } from "@vs/db";
import { captionChunks, secondsToFrames, timeChunks, type AudioTrack, type CaptionCue, type Operation } from "@vs/domain";
import { ElevenLabsTts, LocalTts, OmniVoiceError, OmniVoiceTts, type TtsProvider } from "@vs/providers";
import { probeMedia } from "@vs/rendering";
import { registerFile, type Handler } from "../context";

const LEAD_IN_FRAMES = 6;
const TAIL_FRAMES = 12;

export function narrationHash(text: string, voiceId: string, rate: number, salt = ""): string {
  return createHash("sha256").update(JSON.stringify(salt ? [text.trim(), voiceId, rate, salt] : [text.trim(), voiceId, rate])).digest("hex").slice(0, 24);
}

async function providerFor(voiceId: string, workspaceId: string): Promise<TtsProvider> {
  if (voiceId.startsWith("elevenlabs:")) {
    const s = await getProviderSecret(getDb(), workspaceId, "elevenlabs");
    if (!s) throw new JobError("credentials_missing", "ElevenLabs is not configured.", false, "Add an ElevenLabs key in Settings or choose a local voice.");
    return new ElevenLabsTts(s.secret);
  }
  if (voiceId.startsWith("omnivoice:")) {
    const cfg = await getOmniVoiceConfig(getDb(), workspaceId);
    if (!cfg) throw new JobError("credentials_missing", "OmniVoice is not set up.", false, "Add your OmniVoice server address in Settings → OmniVoice, or choose another voice.");
    const omni = new OmniVoiceTts(cfg.settings, cfg.apiKey);
    return {
      id: omni.id,
      kind: omni.kind,
      voices: () => omni.voices(),
      cacheSalt: (v) => omni.cacheSalt(v),
      synthesize: async (text, v, out, opts) => {
        try {
          return await omni.synthesize(text, v, out, opts);
        } catch (e) {
          if (!(e instanceof OmniVoiceError)) throw e;
          // A stopped server is transient (start it and the job retries); a wrong voice needs a fix.
          throw new JobError(`omnivoice_${e.code}`, e.message, e.code === "unreachable" || e.code === "server_error", e.code === "unknown_voice" ? "Pick a voice the OmniVoice server has, or add it there." : "Open OmniVoice Studio (or start your OmniVoice server) on this computer, then retry.");
        }
      },
    };
  }
  return new LocalTts();
}

/**
 * Generate narration per scene (FR-09). Unchanged text+voice reuses the existing
 * immutable audio asset. Timing follows the measured audio, never an estimate.
 */
export const synthesizeNarration: Handler = async (ctx) => {
  const db = getDb();
  const voiceId = String(ctx.job.input.voiceId ?? "pico:en-US");
  const rate = Number(ctx.job.input.rate ?? 1);
  const fit = (ctx.job.input.fit as "extend" | "keep" | undefined) ?? "extend";
  const provider = await providerFor(voiceId, ctx.job.workspaceId);
  const { revision, doc } = await getProject(db, ctx.job.projectId!, ctx.job.workspaceId);
  const fps = doc.format.fps;
  const scenes = doc.scenes.filter((s) => s.script.narration.trim() && (!ctx.job.input.sceneIds || (ctx.job.input.sceneIds as string[]).includes(s.id)));
  if (!scenes.length) return { status: "nothing_to_do", message: "No scene has a narration script." };

  const ops: Operation[] = [];
  const report: { sceneId: string; reused: boolean; durationSec: number; extendedBySec?: number; warning?: string }[] = [];
  for (const [i, scene] of scenes.entries()) {
    await ctx.stage(`narrating scene ${i + 1} of ${scenes.length}`, i / scenes.length);
    const text = scene.script.narration.trim();
    const hash = narrationHash(text, voiceId, rate, provider.cacheSalt?.(voiceId) ?? "");
    const existing = doc.audio.find((t) => t.kind === "voiceover" && t.anchor.type === "scene" && t.anchor.sceneId === scene.id);
    let track: AudioTrack;
    let durationSec: number;
    if (existing?.generatedFrom?.textHash === hash) {
      track = existing;
      const a = await db.query.assets.findFirst({ where: (x, { eq }) => eq(x.id, existing.assetId) });
      durationSec = Number((a?.media as { durationSec?: number })?.durationSec ?? 0);
      report.push({ sceneId: scene.id, reused: true, durationSec });
    } else {
      const out = join(ctx.workDir, `vo-${scene.id}.wav`);
      const r = await provider.synthesize(text, voiceId, out, { rate, signal: ctx.signal });
      const probe = await probeMedia(r.file);
      durationSec = probe.durationSec ?? 0;
      if (!durationSec) throw new JobError("tts_failed", `Narration for "${scene.purpose}" produced no audio.`, true);
      const asset = await registerFile(ctx.job.workspaceId, r.file, {
        kind: "audio",
        originalName: `narration-${scene.purpose.replace(/\W+/g, "-").toLowerCase()}.wav`,
        generated: true,
        mime: "audio/wav",
        provenance: { source: "tts", provider: r.provider, voiceId, rate, textHash: hash, engineKind: provider.kind, projectId: ctx.job.projectId, sceneId: scene.id },
      });
      track = {
        id: existing?.id ?? newId("trk"),
        kind: "voiceover",
        assetId: asset.id,
        anchor: { type: "scene", sceneId: scene.id, offsetFrames: LEAD_IN_FRAMES },
        sourceInSec: 0,
        sourceOutSec: null,
        gainDb: 0,
        fadeInFrames: 0,
        fadeOutFrames: 3,
        duck: { enabled: false, amountDb: -12 },
        generatedFrom: { textHash: hash, voiceId, provider: r.provider },
      };
      if (existing) ops.push({ op: "removeAudioTrack", trackId: existing.id });
      ops.push({ op: "addAudioTrack", track });
      report.push({ sceneId: scene.id, reused: false, durationSec });
    }
    // Fit: extend the scene when narration overflows (FR-05); locked scenes are reported instead.
    const needed = LEAD_IN_FRAMES + secondsToFrames(durationSec, fps) + TAIL_FRAMES;
    if (needed > scene.durationFrames) {
      if (fit === "extend" && !scene.locked) {
        ops.push({ op: "setSceneDuration", sceneId: scene.id, durationFrames: needed });
        report[report.length - 1]!.extendedBySec = (needed - scene.durationFrames) / fps;
      } else {
        report[report.length - 1]!.warning = scene.locked ? "Scene is locked; narration overflows it." : "Narration overflows the scene; shorten the text, extend the scene or raise the speech rate.";
      }
    }
  }

  // Captions timed across each scene's actual narration audio (segment-level, "estimated").
  const narrated = new Set(scenes.map((s) => s.id));
  const keep = doc.captions.cues.filter((c) => !(c.anchor.type === "scene" && narrated.has(c.anchor.sceneId)));
  const cues: CaptionCue[] = [...keep];
  for (const r of report) {
    const scene = doc.scenes.find((s) => s.id === r.sceneId)!;
    const frames = secondsToFrames(r.durationSec, fps);
    for (const c of timeChunks(captionChunks(scene.script.narration), LEAD_IN_FRAMES, frames)) {
      cues.push({ id: newId("cue"), text: c.text, anchor: { type: "scene", sceneId: scene.id, offsetFrames: 0 }, startFrame: c.startFrame, endFrame: c.endFrame, timing: "estimated" });
    }
  }
  ops.push({ op: "setCaptionCues", cues });
  if (!doc.captions.enabled) ops.push({ op: "setCaptions", captions: { enabled: true } });

  await ctx.stage("applying narration", 1);
  // Scoped to narration tracks, captions and scene durations; retried once on a concurrent edit.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let base = revision.id;
      if (attempt > 0) {
        const cur = await getProject(db, ctx.job.projectId!, ctx.job.workspaceId);
        const changed = scenes.some((s) => cur.doc.scenes.find((x) => x.id === s.id)?.script.narration.trim() !== s.script.narration.trim());
        if (changed) throw new JobError("stale_revision", "A narration script changed while audio was generated; run narration again.", false);
        base = cur.revision.id;
      }
      const r = await db.transaction((tx) => applyProjectOperations(tx, { projectId: ctx.job.projectId!, workspaceId: ctx.job.workspaceId, baseRevisionId: base, ops, actor: "system", author: "system", action: `narration (${voiceId})` }));
      return { revisionId: r.revision.id, scenes: report, voiceId, provider: provider.id, engine: provider.kind };
    } catch (e) {
      if (e instanceof AppError && e.status === 409 && attempt === 0) continue;
      throw e;
    }
  }
  throw new JobError("stale_revision", "The project kept changing while narration was applied; run it again.", true);
};
