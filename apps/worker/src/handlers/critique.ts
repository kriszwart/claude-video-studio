import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, getRevision, getTemplateVersion, newId, schema } from "@vs/db";
import { computeTimeline, ProjectDocument } from "@vs/domain";
import { runCritic, type ClaudeEffort, type CriticFrame } from "@vs/providers";
import { TemplateDefinition } from "@vs/templates";
import { registerFile, type Handler } from "../context";
import { claudeFor, noteLimit, recordUsage, toJobError } from "./ai";
import { issuesFrom, visualPass } from "./quality";

const MAX_FRAMES = 16;

/** Frames Claude sees: each scene's settled hero frame, plus the middle of visible transitions while there is room. */
export function critiqueFrames(doc: ProjectDocument): Omit<CriticFrame, "n">[] {
  const tl = computeTimeline(doc);
  const fps = doc.format.fps;
  const end = tl.totalFrames / fps - 0.05;
  const heroes = doc.scenes.map((s, i) => ({ sceneIndex: i, timeSec: Math.min(end, (tl.scenes[i]!.start + Math.min(Math.round(s.durationFrames * 0.6), 2.5 * fps)) / fps), kind: "hero" as const }));
  const transitions = doc.scenes.flatMap((s, i) => (i > 0 && s.transitionIn.type !== "cut" && s.transitionIn.durationFrames > 0 ? [{ sceneIndex: i, timeSec: (tl.scenes[i]!.start + Math.floor(s.transitionIn.durationFrames / 2)) / fps, kind: "transition" as const }] : []));
  const picked = [...heroes.slice(0, MAX_FRAMES), ...transitions.slice(0, Math.max(0, MAX_FRAMES - heroes.length))];
  return picked.map((f) => ({ ...f, timeSec: Math.round(f.timeSec * 100) / 100 })).sort((a, b) => a.timeSec - b.timeSec);
}

/**
 * Visual critique (Phase 3): render frames of a revision through the real runtime, show them to
 * Claude with the script and measured facts, and store the findings with their evidence frames.
 * Read-only: nothing in the project changes until the owner applies a finding.
 */
export const critique: Handler = async (ctx) => {
  const db = getDb();
  const t0 = Date.now();
  const projectId = ctx.job.projectId!;
  const revisionId = ctx.job.revisionId!;
  const doc = ProjectDocument.parse((await getRevision(db, projectId, revisionId)).document);
  const { version } = await getTemplateVersion(db, ctx.job.workspaceId, doc.template.templateId, doc.template.version);
  const template = TemplateDefinition.parse(version.definition);
  const client = await claudeFor(ctx.job.workspaceId, projectId);

  await ctx.stage("rendering frames");
  const plan = critiqueFrames(doc);
  const pass = await visualPass(ctx, doc, join(ctx.workDir, "critic"), [], plan.map((f) => f.timeSec));
  const frames = await Promise.all(plan.map(async (f, i) => ({ ...f, n: i + 1, file: pass.files[i]!, data: (await readFile(pass.files[i]!)).toString("base64"), mediaType: "image/jpeg" as const })));
  const allMeasured = issuesFrom(doc, pass.report, pass.height);
  // Low contrast goes to Claude to turn into concrete fixes; everything else is Quality review's.
  const measured = allMeasured.filter((i) => !(i.code === "low_contrast" && i.layerId));
  const contrast = allMeasured.flatMap((i) => {
    if (i.code !== "low_contrast" || !i.sceneId || !i.layerId) return [];
    const m = (pass.report.contrast ?? []).filter((c) => c.id === `l-${i.sceneId}-${i.layerId}`).sort((a, b) => a.ratio - b.ratio)[0];
    const layer = doc.scenes.find((s) => s.id === i.sceneId)?.layers.find((l) => l.id === i.layerId);
    if (!m || layer?.kind !== "text") return [];
    return [{ scene: doc.scenes.findIndex((s) => s.id === i.sceneId) + 1, frame: m.frame + 1, layerId: i.layerId, text: layer.text.slice(0, 120), ratio: m.ratio, textColor: m.text, background: m.background, halo: m.halo }];
  });
  const vo = doc.audio.filter((t) => t.kind === "voiceover" && t.anchor.type === "scene");
  const voRows = vo.length ? await db.query.assets.findMany({ where: and(eq(schema.assets.workspaceId, ctx.job.workspaceId), inArray(schema.assets.id, vo.map((t) => t.assetId))) }) : [];
  const voiceoverSec: Record<string, number> = {};
  for (const t of vo) {
    const d = Number((voRows.find((a) => a.id === t.assetId)?.media as { durationSec?: number } | undefined)?.durationSec ?? 0);
    if (d && t.anchor.type === "scene") voiceoverSec[t.anchor.sceneId] = d;
  }

  await ctx.stage("Claude is reviewing");
  let run;
  try {
    run = await runCritic(client, { doc, templateName: template.name, frames, measured, contrast, voiceoverSec, focus: typeof ctx.job.input.focus === "string" ? ctx.job.input.focus.slice(0, 500) : undefined }, { signal: ctx.signal, effort: (ctx.job.input.effort as ClaudeEffort | undefined) ?? "high" });
  } catch (e) {
    await noteLimit(ctx.job.workspaceId, e);
    throw toJobError(e);
  }
  await noteLimit(ctx.job.workspaceId, null, run.usage);
  await recordUsage(ctx.job.workspaceId, projectId, ctx.job.id, run.usage, "critique");

  await ctx.stage("saving evidence");
  const stored = [];
  for (const f of frames) {
    const a = await registerFile(ctx.job.workspaceId, f.file, { kind: "image", originalName: `critic-${projectId}-${f.n}-${f.timeSec.toFixed(2)}s.jpg`, mime: "image/jpeg", provenance: { source: "critic", jobId: ctx.job.id, revisionId, timeSec: f.timeSec } });
    stored.push({ n: f.n, sceneId: doc.scenes[f.sceneIndex]!.id, sceneIndex: f.sceneIndex, timeSec: f.timeSec, kind: f.kind, assetId: a.id });
  }
  const findings = run.output.findings.map((f, i) => ({ id: `f${i + 1}`, ...f, sceneId: f.scene > 0 ? doc.scenes[f.scene - 1]!.id : null }));
  const report = {
    version: "vs-critique/1",
    revisionId,
    summary: run.output.summary,
    scores: run.output.scores,
    strengths: run.output.strengths.slice(0, 3),
    findings,
    frames: stored,
    measured,
    contrast,
    focus: ctx.job.input.focus ?? null,
    model: run.usage.at(-1)?.model ?? null,
    runtime: client.kind,
    attempts: run.attempts,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    limitations: ["Judged from still frames: motion between frames is not seen.", "Contrast is measured on the sampled frames only (DOM text; text drawn inside graphics layers is not measured).", "Audio is judged from the script and measured timings, not by listening."],
  };
  const id = newId("crt");
  await db.insert(schema.critiques).values({ id, workspaceId: ctx.job.workspaceId, projectId, revisionId, jobId: ctx.job.id, report });
  return { critiqueId: id, findings: findings.length, scores: run.output.scores };
};
