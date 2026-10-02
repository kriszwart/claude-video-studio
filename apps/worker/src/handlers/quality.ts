import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AppError, applyProjectOperations, getDb, getRevision, JobError, newId, schema } from "@vs/db";
import { LAYOUTS } from "@vs/compositor";
import { computeTimeline, countIssues, cueIssues, expectedChanges, ProjectDocument, repairCues, validateTimeline, type Operation, type QualityIssue } from "@vs/domain";
import { captureStills, extractFrame, findGlitches, greyFrames, LOOP_SEAM_MAX, loopSeam, lowContrast, MIN_CONTRAST, prepareBundle, renderProject, type PageReport } from "@vs/rendering";
import { referencedAssetIds, registerFile, resolveAssets, type Handler, type JobContext } from "../context";
import { graphicsCompilerFor, needsWebGpu } from "../graphics";
import { measureVoice, pacingIssues } from "./pacing";
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

export async function visualPass(ctx: JobContext, doc: ProjectDocument, dir: string, extraTimes: number[], exactTimes?: number[]) {
  await mkdir(dir, { recursive: true });
  const assets = await resolveAssets(ctx.job.workspaceId, referencedAssetIds(doc));
  const b = await prepareBundle({ doc, assets, workDir: dir, output: join(dir, "unused.mp4"), scale: 0.5, quality: "draft", signal: ctx.signal, graphics: await graphicsCompilerFor(doc, ctx), webgpu: needsWebGpu(doc), extraMix: programMixInputs(doc, assets) }, { withAudio: false });
  const times = exactTimes ?? sampleTimes(doc, extraTimes);
  const stills = await captureStills({ bundleDir: b.bundleDir, width: b.width, height: b.height, times, outPath: (i) => join(dir, `s${String(i).padStart(2, "0")}.jpg`), signal: ctx.signal, webgpu: needsWebGpu(doc), probeText: true });
  return { times, files: stills.files, report: stills.report, height: b.height, width: b.width };
}

/**
 * Smallest text that reads on a phone: 28 px on the short side of a 1080-pixel frame (a 1080p
 * landscape video shown full width on a phone puts that at about 9 px of screen).
 */
export const MIN_PHONE_PX_1080 = 28;
/** A product screen in focus should fill at least this share of the frame width to read on a phone. */
export const MIN_UI_WIDTH: Record<string, number> = { "16:9": 0.4, "1:1": 0.45, "9:16": 0.7 };

/** Image/video layers that show a product screen (device or card frames) and how wide they appear (pure). */
export function smallScreens(doc: ProjectDocument): QualityIssue[] {
  const tl = computeTimeline(doc);
  const fps = doc.format.fps;
  const min = MIN_UI_WIDTH[doc.format.aspect] ?? 0.5;
  const out: QualityIssue[] = [];
  doc.scenes.forEach((scene, i) => {
    for (const l of scene.layers) {
      if (l.hidden || (l.kind !== "image" && l.kind !== "video") || !l.assetId) continue;
      const frame = (l as { frame?: string }).frame ?? "none";
      const ui = frame === "laptop" || frame === "card" || (frame === "phone" && doc.format.aspect === "9:16");
      if (!ui) continue;
      const slot = LAYOUTS[scene.layout]?.[doc.format.aspect]?.[l.slot];
      const w = (l.box?.w ?? slot?.w ?? 1) * (frame === "laptop" ? 0.84 : 1);
      if (w >= min) continue;
      out.push({ code: "ui_too_small", severity: "creative", message: `The product screen in “${scene.purpose}” fills ${Math.round(w * 100)}% of the frame width; on a phone it won't read. Aim for ${Math.round(min * 100)}% or more (a bigger layout, or a full-width card).`, sceneId: scene.id, layerId: l.id, atSec: (tl.scenes[i]!.start + Math.min(Math.round(tl.scenes[i]!.duration * 0.55), 2 * fps)) / fps, repairable: false });
    }
  });
  return out;
}

export function issuesFrom(doc: ProjectDocument, report: PageReport, frameHeight: number, frameWidth = frameHeight): QualityIssue[] {
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
  // Text size on a phone: judged on the frame's short side, so vertical and square videos count too.
  const short = Math.min(frameHeight, frameWidth);
  const sizes = report.sizes ?? (report.shrunk ?? []).flatMap((s) => (s.px !== undefined ? [{ id: s.id, px: s.px, ratio: s.ratio }] : []));
  for (const s of sizes) {
    const f = layerFor(doc, s.id);
    const px1080 = (s.px / short) * 1080;
    if (!f || f.layer.hidden || !("text" in f.layer) || !f.layer.text.trim() || seen.has(f.layer.id) || px1080 >= MIN_PHONE_PX_1080) continue;
    seen.add(f.layer.id);
    if (s.ratio < 0.98) out.push({ code: "text_too_small", severity: "creative", message: `Text in “${f.scene.purpose}” had to shrink to ${Math.round(px1080)} px (at 1080p; ${MIN_PHONE_PX_1080} reads on a phone) to fit and may be hard to read.`, sceneId: f.scene.id, layerId: f.layer.id, atSec: at(f.scene.id), repairable: !f.scene.locked });
    else out.push({ code: "text_small_on_phone", severity: "creative", message: `Text “${f.layer.text.slice(0, 40)}” in “${f.scene.purpose}” is ${Math.round(px1080)} px at 1080p; on a phone, ${MIN_PHONE_PX_1080} px is the smallest that reads. Make it bigger.`, sceneId: f.scene.id, layerId: f.layer.id, atSec: at(f.scene.id), repairable: false });
  }
  out.push(...smallScreens(doc));
  // Counting numbers only show real values: approved numbers, or changes by approved amounts.
  for (const sc of doc.scenes) for (const l of sc.layers) if (l.kind === "text" && l.count && !l.hidden) for (const m of countIssues(doc, sc.id, l)) out.push({ code: "count_not_approved", severity: "creative", message: `Counting number in “${sc.purpose}”: ${m}`, sceneId: sc.id, layerId: l.id, atSec: at(sc.id), repairable: false });
  // Contrast: the worst measured frame per text layer (and one issue for burned-in captions).
  const worst = new Map<string, NonNullable<PageReport["contrast"]>[number]>();
  for (const m of report.contrast ?? []) {
    if (!lowContrast(m)) continue;
    const k = m.id.startsWith("cap-") ? "captions" : m.id;
    if (!worst.has(k) || worst.get(k)!.ratio > m.ratio) worst.set(k, m);
  }
  for (const [k, m] of worst) {
    const advice = m.halo ? "even with its shadow/outline" : `aim for ${MIN_CONTRAST}:1 or more`;
    if (k === "captions") {
      out.push({ code: "low_contrast", severity: "creative", message: `Captions have low contrast with what's behind them (${m.ratio.toFixed(1)}:1, ${advice}). Try the Boxed caption style.`, atSec: m.timeSec, repairable: false });
      continue;
    }
    const f = layerFor(doc, m.id);
    if (!f || f.layer.kind !== "text") continue;
    out.push({ code: "low_contrast", severity: "creative", message: `Text “${f.layer.text.slice(0, 40)}${f.layer.text.length > 40 ? "…" : ""}” in “${f.scene.purpose}” has low contrast with what's behind it (${m.ratio.toFixed(1)}:1 — text ${m.text} on ${m.background}; ${advice}). Change the text colour, darken the background or add a backing plate.`, sceneId: f.scene.id, layerId: f.layer.id, atSec: m.timeSec, repairable: false });
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

/** Glitch scan and loop seam on a rendered file (judged at 64×36, so a draft is enough). */
export async function frameIssues(doc: ProjectDocument, file: string, signal?: AbortSignal): Promise<QualityIssue[]> {
  const g = await greyFrames(file, doc.format.fps, signal);
  const ex = expectedChanges(doc);
  const tl = computeTimeline(doc);
  const sceneAt = (frame: number) => doc.scenes[Math.max(0, tl.scenes.findIndex((s) => frame >= s.start && frame < s.end))]!;
  const out: QualityIssue[] = [];
  for (const gl of findGlitches(g, ex.cuts, (f) => ex.motionFrames.some(([a, b]) => f >= a && f < b)).slice(0, 8)) {
    const scene = sceneAt(gl.frame);
    out.push(
      gl.kind === "flash"
        ? { code: "frame_flash", severity: "creative", message: `A single frame at ${gl.timeSec.toFixed(2)} s in “${scene.purpose}” differs from the frames on both sides of it (a one-frame flash). Look for something drawn for just one frame there.`, sceneId: scene.id, atSec: gl.timeSec, repairable: false }
        : { code: "frame_jump", severity: "creative", message: `At ${gl.timeSec.toFixed(2)} s in “${scene.purpose}” the picture jumps in one frame (${Math.round(gl.diff)} vs about ${Math.max(1, Math.round(gl.around))} for the motion around it), away from any cut or entrance. Something moves or re-centres without easing.`, sceneId: scene.id, atSec: gl.timeSec, repairable: false },
    );
  }
  if (doc.loop) {
    const seam = loopSeam(g);
    if (seam > LOOP_SEAM_MAX) out.push({ code: "loop_seam", severity: "creative", message: `This video is set to loop, but its last frame doesn't match its first (difference ${seam.toFixed(1)}; under ${LOOP_SEAM_MAX} is seamless), so viewers will see a jump when it replays. End on the same picture it opens with.`, atSec: Math.max(0, g.frames.length / g.fps - 0.05), repairable: false });
  }
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
    const issues = [...issuesFrom(doc, v.report, v.height, v.width), ...pacingIssues(doc, await measureVoice(ctx, doc))];
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
  // Motion checks on the rendered file itself: one-frame glitches, and the seam of a looping video.
  await ctx.stage("scanning frames");
  const motionIssues = await frameIssues(bestDoc, out, ctx.signal);
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

  const remaining = [...best.issues, ...motionIssues];
  const audio = { loudness: render.verification.loudness, speechIntervals: render.mix.speechIntervals, truePeakOk: (render.verification.loudness?.truePeakDb ?? -99) <= -1 };
  const limitations = [
    "No model-based visual review in this pass; all checks are measured. For Claude's visual review, use the Critic tab.",
    "Voiceover pacing (rate, pauses, late starts, running past a cut) is measured from the recordings; how natural the voice sounds is not. Text contrast is measured on the sampled frames (DOM text only; text drawn inside graphics layers is not). Presenter framing is judged by the Claude critic, and product fidelity by the product check; review the evidence frames.",
    "Audio: decode, duration, loudness, peaks and ducking are measured; the naturalness of speech edits is not.",
    "Smooth motion is not proven by stills; transition strips are provided for review. The draft is scanned frame by frame for one-frame glitches and sudden jumps (outside cuts, entrances and footage), which catches pops but not every awkward move.",
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

