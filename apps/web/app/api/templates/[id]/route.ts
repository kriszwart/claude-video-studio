import { archiveTemplate, getDb, getTemplateVersion } from "@vs/db";
import { TemplateDefinition } from "@vs/templates";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";
import { templateAvailability } from "@/lib/server/templates";

export const GET = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const v = new URL(req.url).searchParams.get("version");
  const { template, version } = await getTemplateVersion(getDb(), s.workspaceId, id, v ? Number(v) : undefined);
  const def = TemplateDefinition.parse(version.definition);
  return json({ template: { id: template.id, builtin: template.builtin, latestVersion: template.latestVersion }, definition: def, availability: await templateAvailability(def, s.workspaceId) });
});

export const DELETE = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  await archiveTemplate(getDb(), s.workspaceId, id);
  return json({ ok: true });
});
