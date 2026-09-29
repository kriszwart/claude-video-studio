import { z } from "zod";
import { AppError, getDb, getProject, publishUserTemplate } from "@vs/db";
import { checkTemplateIndependence, templateFromProject } from "@vs/templates";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";

const Req = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(600).default(""),
  textVariables: z.array(z.object({ sceneId: z.string().max(64), layerId: z.string().max(64), label: z.string().max(80).optional() })).max(60),
  includeAssetIds: z.array(z.string().max(64)).max(40).default([]),
  existingTemplateId: z.string().max(80).optional(),
  dryRun: z.boolean().default(false),
});

/** Save selected variables as a reusable template (FR-11). dryRun returns the reuse preview. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, Req);
  const db = getDb();
  const { project, revision, doc } = await getProject(db, id, s.workspaceId);
  const r = templateFromProject(doc, { name: b.name, description: b.description, textVariables: b.textVariables, includeAssetIds: b.includeAssetIds, source: { projectId: project.id, revisionId: revision.id } });
  const check = checkTemplateIndependence(r.definition, doc, r.packagedAssetIds);
  if (!check.ok) throw new AppError(422, "hidden_dependency", `The template still depends on media from this project: ${check.leaks.join(", ")}.`);
  const preview = { scenes: check.preview.scenes.map((sc) => ({ purpose: sc.purpose, layout: sc.layout, durationSec: sc.durationFrames / 30, texts: sc.layers.filter((l) => l.kind === "text").map((l) => (l.kind === "text" ? l.text : "")) })) };
  if (b.dryRun) return json({ variables: r.variables, packagedAssetIds: r.packagedAssetIds, preview });
  const saved = await db.transaction((tx) => publishUserTemplate(tx, s.workspaceId, r.definition as never, { existingTemplateId: b.existingTemplateId }));
  return json({ ...saved, variables: r.variables, packagedAssetIds: r.packagedAssetIds, preview }, 201);
});
