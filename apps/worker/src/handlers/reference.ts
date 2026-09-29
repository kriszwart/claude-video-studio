import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, JobError, schema } from "@vs/db";
import { traitsFromMeasurements, type ReferenceMeasurements } from "@vs/domain";
import { ANALYSIS_SR, analyzePcm, decodeMono, extractFrame, FFMPEG, measureLoudness, run } from "@vs/rendering";
import { registerFile, resolveAssets, type Handler } from "../context";

/** Hard cuts via ffmpeg's scene-change score, plus per-frame change for a motion measure. */
async function sceneScores(file: string, signal: AbortSignal) {
  const r = await run(FFMPEG, ["-hide_banner", "-nostdin", "-i", file, "-an", "-vf", "scale=160:-2,select='gte(scene\\,0)',metadata=print:key=lavfi.scene_score", "-f", "null", "-"], { signal, timeoutMs: 600_000 });
  const times = [...r.stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
  const scores = [...r.stderr.matchAll(/lavfi\.scene_score=([\d.]+)/g)].map((m) => Number(m[1]));
  return times.map((t, i) => ({ t, s: scores[i] ?? 0 }));
}

async function blackSegments(file: string, signal: AbortSignal) {
  const r = await run(FFMPEG, ["-hide_banner", "-nostdin", "-i", file, "-an", "-vf", "blackdetect=d=0.04:pix_th=0.08", "-f", "null", "-"], { signal, timeoutMs: 600_000 });
  return [...r.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
}

/** Transient density and near-silence share from a 23 ms RMS envelope. */
function onsetStats(pcm: Float32Array) {
  const hop = Math.round(ANALYSIS_SR * 0.023);
  const db: number[] = [];
  for (let i = 0; i + hop <= pcm.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += pcm[j]! * pcm[j]!;
    db.push(10 * Math.log10(s / hop + 1e-12));
  }
  let onsets = 0;
  let last = -99;
  for (let k = 4; k < db.length; k++) {
    const floor = Math.min(db[k - 1]!, db[k - 2]!, db[k - 3]!, db[k - 4]!);
    if (db[k]! > -45 && db[k]! - floor > 6 && k - last > 3) {
      onsets++;
      last = k;
    }
  }
  const dur = pcm.length / ANALYSIS_SR;
  return { onsetsPerSec: dur ? onsets / dur : 0, silenceRatio: db.length ? db.filter((d) => d < -50).length / db.length : 1 };
}

/**
 * Analyse a supplied reference clip into observable traits with time-coded evidence (FR-17).
 * Measures shot lengths, transitions (hard cut vs through black), frame-to-frame change and,
 * when there is audio, loudness, transient density and tempo. Evidence frames are stored as
 * assets. The result is a *proposal*: nothing is saved as a profile until the user does so.
 */
export const analyzeReference: Handler = async (ctx) => {
  const db = getDb();
  const assetId = String(ctx.job.input.assetId ?? "");
  const asset = await db.query.assets.findFirst({ where: and(eq(schema.assets.id, assetId), eq(schema.assets.workspaceId, ctx.job.workspaceId)) });
  if (!asset || asset.status !== "ready") throw new JobError("not_found", "The reference isn't available.", false);
  const file = (await resolveAssets(ctx.job.workspaceId, [asset.id])).get(asset.id)!;
  const media = asset.media as { durationSec?: number; hasAudio?: boolean };
  const frames: ReferenceMeasurements["frames"] = [];

  if (asset.kind === "image" || asset.kind === "svg") {
    const m: ReferenceMeasurements = { kind: "image", durationSec: null, cuts: [], fadeCuts: [], meanMotion: null, hasAudio: false, loudnessLufs: null, onsetsPerSec: null, silenceRatio: null, tempoBpm: null, frames: [{ timeSec: 0, assetId: asset.id }] };
    return { measurements: m, traits: traitsFromMeasurements(m) };
  }
  if (asset.kind !== "video") throw new JobError("invalid_input", "Reference analysis needs a video clip (or screenshots).", false);
  const duration = Number(media.durationSec ?? 0);

  await ctx.stage("measuring shots");
  const scores = await sceneScores(file.path, ctx.signal);
  const blacks = await blackSegments(file.path, ctx.signal);
  const fadeCuts = blacks.filter((b) => b.start > 0.2 && b.end < duration - 0.2).map((b) => Math.round(((b.start + b.end) / 2) * 1000) / 1000);
  const hard = scores.filter((x) => x.s > 0.3).map((x) => x.t);
  const cuts = [...fadeCuts, ...hard.filter((t) => !blacks.some((b) => t >= b.start - 0.5 && t <= b.end + 0.5))].sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1]! > 0.4);
  const moving = scores.filter((x) => x.s <= 0.3 && !blacks.some((b) => x.t >= b.start - 0.3 && x.t <= b.end + 0.3));
  const meanMotion = moving.length ? moving.reduce((a, x) => a + x.s, 0) / moving.length : null;

  await ctx.stage("evidence frames");
  const bounds = [0, ...cuts, duration];
  const mids = bounds.slice(0, -1).map((b, i) => (b + bounds[i + 1]!) / 2).slice(0, 8);
  for (const [i, t] of mids.entries()) {
    const out = join(ctx.workDir, `ref-${i}.jpg`);
    await extractFrame(file.path, t, out, 640);
    const a = await registerFile(ctx.job.workspaceId, out, { kind: "image", originalName: `reference-${asset.originalName}-${t.toFixed(2)}s.jpg`, mime: "image/jpeg", provenance: { source: "reference-analysis", referenceAssetId: asset.id, timeSec: t, jobId: ctx.job.id } });
    frames.push({ timeSec: Math.round(t * 1000) / 1000, assetId: a.id });
  }

  let loudnessLufs: number | null = null;
  let onsetsPerSec: number | null = null;
  let silenceRatio: number | null = null;
  let tempoBpm: number | null = null;
  if (media.hasAudio) {
    await ctx.stage("analysing sound");
    loudnessLufs = (await measureLoudness(file.path, ctx.signal))?.lufs ?? null;
    const pcm = await decodeMono(file.path);
    ({ onsetsPerSec, silenceRatio } = onsetStats(pcm));
    const a = analyzePcm(pcm);
    tempoBpm = a.tempoConfidence > 0.3 ? a.bpm : null;
  }
  const m: ReferenceMeasurements = { kind: "video", durationSec: duration, cuts, fadeCuts, meanMotion, hasAudio: !!media.hasAudio, loudnessLufs, onsetsPerSec, silenceRatio, tempoBpm, frames };
  return { referenceAssetId: asset.id, measurements: m, traits: traitsFromMeasurements(m) };
};
