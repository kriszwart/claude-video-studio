import { and, eq, inArray } from "drizzle-orm";
import { getDb, getTemplateVersion, JobError, schema } from "@vs/db";
import { EFFORT_LEVELS, runComposer, type AssetManifestEntry, type ComposeSettings, type EffortLevel } from "@vs/providers";
import { TemplateDefinition } from "@vs/templates";
import type { Handler } from "../context";
import { claudeFor, noteLimit, recordUsage, toJobError } from "./ai";

/**
 * Composer (Phase 2): one prompt → template, settings and filled inputs, for the owner to
 * review. Creates nothing; the regular project-creation path builds the project afterwards.
 */
export const composeBrief: Handler = async (ctx) => {
  const db = getDb();
  const input = ctx.job.input as { prompt: string; templateIds: string[]; templateId: string | null; settings: ComposeSettings; effort: EffortLevel; assetIds: string[] };
  const templates: TemplateDefinition[] = [];
  const versions = new Map<string, number>();
  for (const id of input.templateIds) {
    try {
      const { version } = await getTemplateVersion(db, ctx.job.workspaceId, id);
      templates.push(TemplateDefinition.parse(version.definition));
      versions.set(id, version.version);
    } catch {
      // A template archived since the request was made is simply not offered.
    }
  }
  if (!templates.length) throw new JobError("no_templates", "No template is available for this request.", false, "Attach the media a template needs, or check Settings for missing providers.");
  const rows = input.assetIds.length ? await db.query.assets.findMany({ where: and(eq(schema.assets.workspaceId, ctx.job.workspaceId), inArray(schema.assets.id, input.assetIds), eq(schema.assets.status, "ready")) }) : [];
  const assets: AssetManifestEntry[] = rows.map((a) => {
    const m = a.media as { width?: number; height?: number; durationSec?: number };
    return { id: a.id, kind: a.kind as AssetManifestEntry["kind"], name: a.originalName.slice(0, 80), width: m.width, height: m.height, durationSec: m.durationSec, generated: a.generated };
  });
  const client = await claudeFor(ctx.job.workspaceId, `compose-${ctx.job.id}`);
  await ctx.stage("reading your request");
  let run;
  try {
    run = await runComposer(client, { prompt: input.prompt, templates, templateId: input.templateId, settings: input.settings, assets }, { signal: ctx.signal, effort: EFFORT_LEVELS[input.effort]?.compose ?? "medium" });
  } catch (e) {
    await noteLimit(ctx.job.workspaceId, e);
    throw toJobError(e);
  }
  await noteLimit(ctx.job.workspaceId, null, run.usage);
  await recordUsage(ctx.job.workspaceId, null, ctx.job.id, run.usage, "compose");
  const t = templates.find((x) => x.id === run.output.templateId)!;
  const facts = t.inputs.filter((f) => f.kind === "facts").map((f) => ({ inputId: f.id, label: f.label, items: (run.inputs[f.id] as string[] | undefined) ?? [] }));
  return {
    templateId: t.id,
    templateVersion: versions.get(t.id),
    templateName: t.name,
    title: run.output.title,
    aspect: run.output.aspect,
    durationSec: run.output.durationSec,
    narration: run.output.narration,
    inputs: run.inputs,
    facts,
    rationale: run.output.rationale,
    warnings: run.output.warnings,
    attempts: run.attempts,
    runtime: client.kind,
  };
};
