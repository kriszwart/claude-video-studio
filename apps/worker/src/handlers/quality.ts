import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AppError, applyProjectOperations, getDb, getRevision, JobError, newId, schema } from "@vs/db";
import { LAYOUTS } from "@vs/compositor";
import { computeTimeline, cueIssues, ProjectDocument, repairCues, validateTimeline, type Operation, type QualityIssue } from "@vs/domain";
import { captureStills, extractFrame, prepareBundle, renderProject, type PageReport } from "@vs/rendering";
import { referencedAssetIds, registerFile, resolveAssets, type Handler, type JobContext } from "../context";
import { graphicsCompilerFor, needsWebGpu } from "../graphics";
import { programMixInputs } from "../program";

interface PassRecord {
  pass: number;
  revisionId: string;
  sampledTimes: number[];
  issues: QualityIssue[];
  repairs: { op: string; target: string; detail: string }[];
  evidence: { timeSec: number; assetId: string; why: string }[];
}

const key = (i: QualityIssue) => `${i.code}:${i.layerId ?? i.cueId ?? i.sceneId ?? ""}`;

/** Which layer a compositor DOM id ("l-<scene>-<layer>") refers to. */
function layerFor(doc: ProjectDocument, domId: string) {
  for (const s of doc.scenes) for (const l of s.layers) if (`l-${s.id}-${l.id}` === domId) return { scene: s, layer: l };
  return null;
}

function sampleTimes(doc: ProjectDocument, extra: number[]): number[] {
  const tl = computeTimeline(doc);
  const fps = doc.format.fps;
  const t: number[] = [];
  doc.scenes.forEach((s, i) => {
    const st = tl.scenes[i]!;
    // Hero frame: after entrances settle (about 55% in, at most 2 s).
    t.push((st.start + Math.min(Math.round(st.duration * 0.55), 2 * fps)) / fps);
    if (i > 0 && s.transitionIn.type !== "cut") t.push((st.start + Math.floor(s.transitionIn.durationFrames / 2)) / fps);
  });
  return [...new Set([...t, ...extra].map((x) => Math.round(Math.min(tl.totalFrames / fps - 0.05, Math.max(0, x)) * 100) / 100))].sort((a, b) => a - b).slice(0, 40);
}

async function visualPass(ctx: JobContext, doc: ProjectDocument, dir: string, extraTimes: number[]) {
  await mkdir(dir, { recursive: true });
  const assets = await resolveAssets(ctx.job.workspaceId, referencedAssetIds(doc));
  const b = await prepareBundle({ doc, assets, workDir: dir, output: join(dir, "unused.mp4"), scale: 0.5, quality: "draft", signal: ctx.signal, graphics: await graphicsCompilerFor(doc, ctx), webgpu: needsWebGpu(doc), extraMix: programMixInputs(doc, assets) }, { withAudio: false });
  const times = sampleTimes(doc, extraTimes);
  const stills = await captureStills({ bundleDir: b.bundleDir, width: b.width, height: b.height, times, outPath: (i) => join(dir, `s${String(i).padStart(2, "0")}.jpg`), signal: ctx.signal, webgpu: needsWebGpu(doc) });
  return { times, files: stills.files, report: stills.report, height: b.height };
}

/** Smallest readable text: 26 px on a 1080-line frame (≈2.4% of frame height). */
const MIN_READABLE_PX_1080 = 26;

function issuesFrom(doc: ProjectDocument, report: PageReport, frameHeight: number): QualityIssue[] {
  const tl = computeTimeline(doc);
  const fps = doc.format.fps;
  const at = (sceneId: string) => {
    const i = doc.scenes.findIndex((s) => s.id === sceneId);
    return i < 0 ? undefined : (tl.scenes[i]!.start + Math.min(Math.round(tl.scenes[i]!.duration * 0.55), 2 * fps)) / fps;
  };
  const out: QualityIssue[] = [];
  const seen = new Set<string>();
  for (const id of report.overflow) {
    const f = layerFor(doc, id);
    if (!f || seen.has(f.layer.id)) continue;
    seen.add(f.layer.id);
    out.push({ code: "text_overflow", severity: "creative", message: `Text in “${f.scene.purpose}” doesn't fit its box even at the smallest allowed size.`, sceneId: f.scene.id, layerId: f.layer.id, atSec: at(f.scene.id), repairable: !f.scene.locked });
  }
  for (const s of report.shrunk ?? []) {
    const f = layerFor(doc, s.id);
    const px1080 = s.px !== undefined ? (s.px / frameHeight) * 1080 : null;
    if (!f || seen.has(f.layer.id) || px1080 === null || px1080 >= MIN_READABLE_PX_1080) continue;
    seen.add(f.layer.id);
    out.push({ code: "text_too_small", severity: "creative", message: `Text in “${f.scene.purpose}” had to shrink to ${Math.round(px1080)} px (at 1080p; minimum ${MIN_READABLE_PX_1080}) to fit and may be hard to read.`, sceneId: f.scene.id, layerId: f.layer.id, atSec: at(f.scene.id), repairable: !f.scene.locked });
  }
  for (const fam of report.missingFonts) out.push({ code: "missing_font", severity: "hard", message: `Font “${fam}” did not load; a fallback was used.`, repairable: false });
  out.push(...cueIssues(doc));
  for (const v of validateTimeline(doc)) {
    if (v.severity === "error") out.push({ code: v.code, severity: "hard", message: v.message, sceneId: v.sceneId, layerId: v.layerId, repairable: false });
    else if (v.code === "missing_asset") out.push({ code: v.code, severity: "creative", message: v.message, sceneId: v.sceneId, layerId: v.layerId, repairable: false });
  }
  for (const i of out) if (i.sceneId && doc.scenes.find((s) => s.id === i.sceneId)?.locked && i.repairable) i.repairable = false;
  return out;
}

/** Layout-only repairs: give overflowing or over-shrunk text more room. Text and its designed size are never changed. */
function repairOps(doc: ProjectDocument, issues: QualityIssue[]): { ops: Operation[]; repairs: PassRecord["repairs"] } {
  const ops: Operation[] = [];
  const repairs: PassRecord["repairs"] = [];
  for (const iss of issues.filter((i) => i.repairable && (i.code === "text_overflow" || i.code === "text_too_small"))) {
    const scene = doc.scenes.find((s) => s.id === iss.sceneId)!;
    const layer = scene.layers.find((l) => l.id === iss.layerId);
    if (!layer || layer.kind !== "text") continue;
    const slot = LAYOUTS[scene.layout]?.[doc.format.aspect]?.[layer.slot];
    const cur = layer.box ?? (slot ? { x: slot.x, y: slot.y, w: slot.w, h: slot.h } : { x: 0.05, y: 0.4, w: 0.9, h: 0.2 });
    const h = Math.min(0.9, cur.h * 1.7);
    const grow = h - cur.h;
    const y = slot?.valign === "end" ? Math.max(0.02, cur.y - grow) : slot?.valign === "start" ? cur.y : Math.max(0.02, cur.y - grow / 2);
    const w = Math.min(0.96 - Math.max(0.02, cur.x) + 0.02, cur.w * 1.15);
    const box = { x: Math.max(0.02, Math.min(cur.x, 1 - w - 0.02)), y: Math.min(y, 0.98 - h), w, h };
    ops.push({ op: "setLayerBox", sceneId: scene.id, layerId: layer.id, box });
    repairs.push({ op: "setLayerBox", target: `${scene.purpose} / ${layer.slot}`, detail: `box ${fmtBox(cur)} → ${fmtBox(box)}` });
  }
  const cueFix = issues.filter((i) => i.repairable && i.cueId);
  if (cueFix.length) {
    const { cues, fixed } = repairCues(doc, cueFix);
    if (fixed.length) {
      ops.push({ op: "setCaptionCues", cues });
      for (const id of fixed) repairs.push({ op: "setCaptionCues", target: id, detail: `timing of caption “${doc.captions.cues.find((c) => c.id === id)?.text.slice(0, 40)}” corrected` });
    }
  }
  return { ops, repairs };
}
const fmtBox = (b: { x: number; y: number; w: number; h: number }) => `[${[b.x, b.y, b.w, b.h].map((n) => n.toFixed(2)).join(", ")}]`;

/**
 * Bounded render–review–repair (FR-18, A22). Each pass renders sample frames through the real
 * runtime (hero frames, transitions, cue events), checks text fit, fonts, captions and the
 * timeline, and applies scoped, reproducible repairs as normal revisions. Stops when clean,
 * on an unchanged repeated failure, when nothing is repairable, or at the pass/time bound.
 * The final draft is rendered and verified; the stored report links every artifact.
 */
export const qualityReview: Handler = async (ctx) => {
  const db = getDb();
  const projectId = ctx.job.projectId!;
  const maxPasses = Math.max(0, Math.min(5, Number(ctx.job.input.maxRepairPasses ?? process.env.QA_MAX_REPAIR_PASSES ?? 2)));
  const maxSec = Number(ctx.job.input.maxJobSec ?? process.env.QA_MAX_JOB_SEC ?? 900);
  const t0 = Date.now();
  let revisionId = ctx.job.revisionId!;
  const passes: PassRecord[] = [];
  let stopReason = "clean";
  let prevSig = "";

  for (let pass = 0; ; pass++) {
    const rev = await getRevision(db, projectId, revisionId);
    const doc = ProjectDocument.parse(rev.document);
    await ctx.stage(`review pass ${pass + 1}`);
    const cueTimes = cueIssues(doc).map((i) => i.atSec).filter((x): x is number => x !== undefined);
    const v = await visualPass(ctx, doc, join(ctx.workDir, `pass${pass}`), cueTimes);
    const issues = issuesFrom(doc, v.report, v.height);
    // Evidence: frames at issue times (or the first hero frames when clean), stored as assets.
    const evidence: PassRecord["evidence"] = [];
    const want = issues.length ? issues.filter((i) => i.atSec !== undefined).map((i) => ({ t: i.atSec!, why: i.code })) : v.times.slice(0, 3).map((t) => ({ t, why: "hero frame" }));
    for (const w of want.slice(0, 6)) {
      const idx = v.times.reduce((best, t, i) => (Math.abs(t - w.t) < Math.abs(v.times[best]! - w.t) ? i : best), 0);
      const a = await registerFile(ctx.job.workspaceId, v.files[idx]!, { kind: "image", originalName: `qa-${projectId}-p${pass + 1}-${v.times[idx]!.toFixed(2)}s.jpg`, mime: "image/jpeg", provenance: { source: "quality-review", jobId: ctx.job.id, revisionId, timeSec: v.times[idx] } });
      if (!evidence.some((e) => e.assetId === a.id)) evidence.push({ timeSec: v.times[idx]!, assetId: a.id, why: w.why });
    }
    const record: PassRecord = { pass: pass + 1, revisionId, sampledTimes: v.times, issues, repairs: [], evidence };
    passes.push(record);
    const sig = issues.map(key).sort().join("|");
    if (!issues.length) break;
    if (sig === prevSig) {
      stopReason = "unchanged repeated failure";
      break;
    }
    if (pass >= maxPasses) {
      stopReason = "repair pass limit reached";
      break;
    }
    if ((Date.now() - t0) / 1000 > maxSec) {
      stopReason = "time limit reached";
      break;
    }
    const { ops, repairs } = repairOps(doc, issues);
    if (!ops.length) {
      stopReason = "no automatic repair available";
      break;
    }
    try {
      const r = await db.transaction((tx) => applyProjectOperations(tx, { projectId, workspaceId: ctx.job.workspaceId, baseRevisionId: revisionId, ops, actor: "system", author: "system", action: `quality repair (pass ${pass + 1})` }));
      record.repairs = repairs;
      revisionId = r.revision.id;
    } catch (e) {
      stopReason = e instanceof AppError && e.status === 409 ? "project changed during review" : `repair refused: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }
    prevSig = sig;
  }

  // Best verified draft: the pass with the fewest hard, then total, issues.
  const best = [...passes].sort((a, b) => a.issues.filter((i) => i.severity === "hard").length - b.issues.filter((i) => i.severity === "hard").length || a.issues.length - b.issues.length || b.pass - a.pass)[0]!;
  await ctx.stage("rendering draft");
  const bestDoc = ProjectDocument.parse((await getRevision(db, projectId, best.revisionId)).document);
  const assets = await resolveAssets(ctx.job.workspaceId, referencedAssetIds(bestDoc));
  const out = join(ctx.workDir, "draft.mp4");
  const render = await renderProject({ doc: bestDoc, assets, workDir: join(ctx.workDir, "render"), output: out, scale: Number(process.env.PREVIEW_SCALE ?? 0.5), quality: "draft", signal: ctx.signal, graphics: await graphicsCompilerFor(bestDoc, ctx), webgpu: needsWebGpu(bestDoc), extraMix: programMixInputs(bestDoc, assets) });
  const technical = render.verification.checks;
  const hardFail = technical.some((c) => c.severity === "hard" && !c.ok);
  // Temporal evidence: short frame strips around transitions (stills alone can't prove smooth motion).
  const tl = computeTimeline(bestDoc);
  const fps = bestDoc.format.fps;
  const temporal: { timeSec: number; assetId: string }[] = [];
  for (const i of bestDoc.scenes.keys()) {
    if (i === 0 || temporal.length >= 3) continue;
    const t = tl.scenes[i]!.start / fps;
    const strip = join(ctx.workDir, `strip-${i}.jpg`);
    const parts: string[] = [];
    for (const [k, d] of [-0.2, -0.07, 0.07, 0.2, 0.4].entries()) {
      const f = join(ctx.workDir, `strip-${i}-${k}.jpg`);
      await extractFrame(out, Math.max(0, t + d), f, 320);
      parts.push(f);
    }
    execFileSync("ffmpeg", ["-v", "error", "-y", ...parts.flatMap((p) => ["-i", p]), "-filter_complex", `hstack=inputs=${parts.length}`, strip]);
    const a = await registerFile(ctx.job.workspaceId, strip, { kind: "image", originalName: `qa-${projectId}-transition-${i}.jpg`, mime: "image/jpeg", provenance: { source: "quality-review", jobId: ctx.job.id, kind: "transition strip", timeSec: t } });
    temporal.push({ timeSec: Math.round(t * 1000) / 1000, assetId: a.id });
  }
  const video = await registerFile(ctx.job.workspaceId, out, { kind: "render", originalName: `qa-draft-${projectId}.mp4`, mime: "video/mp4", provenance: { source: "quality-review", jobId: ctx.job.id, revisionId: best.revisionId, bundleHash: render.bundleHash } });
  const thumb = temporal[0]?.assetId ?? best.evidence[0]?.assetId;
  await db
    .insert(schema.exportsTable)
    .values({ id: newId("exp"), workspaceId: ctx.job.workspaceId, projectId, revisionId: best.revisionId, jobId: ctx.job.id, kind: "preview", videoAssetId: video.id, thumbnailAssetId: thumb, width: render.width, height: render.height, durationSec: render.totalFrames / render.fps, bundleHash: render.bundleHash, verification: { ...render.verification, mix: render.mix, warnings: render.warnings } })
    .onConflictDoNothing({ target: schema.exportsTable.jobId });

  const remaining = best.issues;
  const audio = { loudness: render.verification.loudness, speechIntervals: render.mix.speechIntervals, truePeakOk: (render.verification.loudness?.truePeakDb ?? -99) <= -1 };
  const limitations = [
    "No model-based visual review in this pass; all checks are measured.",
    "Contrast, presenter coverage and asset fidelity are not scored automatically; review the evidence frames.",
    "Audio: decode, duration, loudness, peaks and ducking are measured; the naturalness of speech edits is not.",
    "Smooth motion is not proven by stills; transition strips are provided for review.",
  ];
  const verdict = hardFail || remaining.some((i) => i.severity === "hard") ? "failed" : remaining.length ? "needs_review" : "ready";
  const report = {
    version: "vs-quality/1",
    finalRevisionId: best.revisionId,
    startRevisionId: ctx.job.revisionId,
    maxRepairPasses: maxPasses,
    repairPassesUsed: passes.filter((p) => p.repairs.length).length,
    stopReason,
    passes,
    technical,
    audio,
    temporal,
    draft: { videoAssetId: video.id, bundleHash: render.bundleHash },
    unresolved: remaining,
    costMicros: 0,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    limitations,
  };
  const id = newId("qar");
  await db.insert(schema.qualityReports).values({ id, workspaceId: ctx.job.workspaceId, projectId, revisionId: best.revisionId, jobId: ctx.job.id, verdict, report });
  if (hardFail) throw new JobError("verification_failed", "The draft failed technical verification; see the quality report.", false);
  return { qualityReportId: id, verdict, stopReason, passes: passes.length, repairs: passes.reduce((a, p) => a + p.repairs.length, 0), unresolved: remaining.length, finalRevisionId: best.revisionId };
};

