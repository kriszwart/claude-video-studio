import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { AppError, enqueueJob, getDb, listTemplates, schema } from "@vs/db";
import { SCRIPT_STYLE_IDS } from "@vs/domain";
import { ASPECTS, EFFORT_LEVELS } from "@vs/providers";
import { TemplateDefinition } from "@vs/templates";
import { requireSession } from "@/lib/server/auth";
import { requireClaude } from "@/lib/server/claude";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { serializeJob } from "@/lib/server/serialize";
import { templateAvailability } from "@/lib/server/templates";

const Compose = z.object({
  prompt: z.string().trim().min(3, "Describe the video in a few words.").max(4000),
  templateId: z.string().max(80).nullable().default(null),
  settings: z
    .object({
      aspect: z.enum(ASPECTS).nullable().default(null),
      durationSec: z.number().min(5).max(600).nullable().default(null),
      music: z.enum(["auto", "on", "off"]).default("auto"),
      voice: z.enum(["auto", "off", "on"]).default("auto"),
      scriptStyle: z.enum(SCRIPT_STYLE_IDS).nullable().default(null),
    })
    .default({ aspect: null, durationSec: null, music: "auto", voice: "auto", scriptStyle: null }),
  effort: z.enum(Object.keys(EFFORT_LEVELS) as [keyof typeof EFFORT_LEVELS, ...(keyof typeof EFFORT_LEVELS)[]]).default("standard"),
  assetIds: z.array(z.string().max(64)).max(24).default([]),
});

const MEDIA_KINDS: Record<string, string[]> = { image: ["image", "svg"], images: ["image", "svg"], audio: ["audio"], video: ["video"], videos: ["video"], subtitle: ["document"] };

/**
 * Composer: Claude reads a one-line request and proposes template, settings and inputs. Only
 * templates whose providers are available and whose required media is attached are offered.
 */
export const POST = route(async (req) => {
  const s = await requireSession();
  const input = await body(req, Compose);
  await requireClaude(s.workspaceId);
  const db = getDb();
  const rows = input.assetIds.length ? await db.query.assets.findMany({ where: and(eq(schema.assets.workspaceId, s.workspaceId), inArray(schema.assets.id, input.assetIds)) }) : [];
  if (rows.length !== new Set(input.assetIds).size) throw new AppError(422, "unknown_asset", "An attached file is not available.");
  const pending = rows.find((a) => a.status !== "ready");
  if (pending) throw new AppError(409, "asset_not_ready", `"${pending.originalName}" is still processing.`);
  const kinds = new Set(rows.map((a) => a.kind));
  const eligible: string[] = [];
  let pinnedProblem: string | null = null;
  for (const { template, version } of await listTemplates(db, s.workspaceId)) {
    const def = TemplateDefinition.parse(version.definition);
    const avail = await templateAvailability(def, s.workspaceId);
    const missingMedia = def.inputs.filter((f) => f.required && MEDIA_KINDS[f.kind] && !MEDIA_KINDS[f.kind]!.some((k) => kinds.has(k as (typeof rows)[number]["kind"])));
    if (template.id === input.templateId) {
      if (!avail.ready) pinnedProblem = avail.workerOnline ? `${def.name} needs: ${avail.missingRequired.join(", ")}.` : "No render worker is online.";
      else if (missingMedia.length) pinnedProblem = `${def.name} needs ${missingMedia.map((f) => f.label.toLowerCase()).join(" and ")} — attach ${missingMedia.length > 1 ? "them" : "it"} with +.`;
    }
    if (avail.ready && !missingMedia.length) eligible.push(template.id);
  }
  if (input.templateId && pinnedProblem) throw new AppError(422, "template_unavailable", pinnedProblem);
  if (input.templateId && !eligible.includes(input.templateId)) throw new AppError(422, "template_unavailable", "That template is not available.");
  if (!eligible.length) throw new AppError(422, "no_templates", "No template can be used right now.", "Check that a render worker is running.");
  const { job } = await enqueueJob(db, {
    workspaceId: s.workspaceId,
    type: "compose",
    input: { prompt: input.prompt, templateIds: eligible, templateId: input.templateId, settings: input.settings, effort: input.effort, assetIds: input.assetIds },
    idempotencyKey: idempotencyKey(req) ? `compose:${idempotencyKey(req)}` : null,
    maxAttempts: 1,
  });
  return json({ job: serializeJob(job) }, 202);
});
