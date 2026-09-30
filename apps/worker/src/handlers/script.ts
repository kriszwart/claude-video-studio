import { AppError, applyProjectOperations, getDb, getProject, getTemplateVersion, newId } from "@vs/db";
import { SCRIPT_STYLE_IDS, type ScriptStyle } from "@vs/domain";
import { runScriptwriter } from "@vs/providers";
import { TemplateDefinition } from "@vs/templates";
import type { Handler } from "../context";
import { claudeFor, noteLimit, recordUsage, toJobError } from "./ai";

/**
 * Script stage: Claude writes (or rewrites, with the owner's note) the narration and on-screen
 * line per beat. The result is stored as a draft script; nothing is planned until the owner
 * approves it.
 */
export const writeScript: Handler = async (ctx) => {
  const db = getDb();
  const input = ctx.job.input as { style?: ScriptStyle; direction?: string; narrated?: boolean; note?: string; targetDurationSec?: number; next?: { planEffort?: string; voiceId?: string } };
  const { doc } = await getProject(db, ctx.job.projectId!, ctx.job.workspaceId);
  const { version } = await getTemplateVersion(db, ctx.job.workspaceId, doc.template.templateId, doc.template.version);
  const template = TemplateDefinition.parse(version.definition);
  const previous = doc.script;
  const style: ScriptStyle = input.style && SCRIPT_STYLE_IDS.includes(input.style) ? input.style : (previous?.style ?? "professor");
  const narrated = input.narrated ?? previous?.narrated ?? template.audio.narration !== "none";
  const target = input.targetDurationSec ?? Math.round(doc.scenes.reduce((a, s) => a + s.durationFrames, 0) / doc.format.fps);
  const client = await claudeFor(ctx.job.workspaceId, ctx.job.projectId ?? ctx.job.id);
  await ctx.stage("writing the script");
  let run;
  try {
    run = await runScriptwriter(client, { template, doc, style, direction: input.direction ?? previous?.direction ?? "", narrated, targetDurationSec: target, note: input.note, previous: input.note ? previous : undefined, newId }, { signal: ctx.signal });
  } catch (e) {
    await noteLimit(ctx.job.workspaceId, e);
    throw toJobError(e);
  }
  await noteLimit(ctx.job.workspaceId, null, run.usage);
  await recordUsage(ctx.job.workspaceId, ctx.job.projectId, ctx.job.id, run.usage, "script");
  const script = { ...run.script, next: { ...(previous?.next ?? {}), ...(input.next ?? {}) } as typeof run.script.next };
  // Only the script changes, so apply on whatever the current revision is (one retry on a race).
  for (let attempt = 0; ; attempt++) {
    const { project } = await getProject(db, ctx.job.projectId!, ctx.job.workspaceId);
    try {
      const r = await db.transaction((tx) => applyProjectOperations(tx, { projectId: project.id, workspaceId: ctx.job.workspaceId, baseRevisionId: project.currentRevisionId!, ops: [{ op: "setScript", script }], actor: "system", author: "planner", action: input.note ? "script rewritten" : "script written" }));
      return { revisionId: r.revision.id, beats: script.beats.length, attempts: run.attempts, remainingIssues: run.remaining.length, style };
    } catch (e) {
      if (!(e instanceof AppError && e.status === 409) || attempt > 0) throw toJobError(e);
    }
  }
};
