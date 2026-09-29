import { getDb, listTemplates } from "@vs/db";
import { TemplateDefinition } from "@vs/templates";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";
import { templateAvailability } from "@/lib/server/templates";

export const GET = route(async () => {
  const s = await requireSession();
  const rows = await listTemplates(getDb(), s.workspaceId);
  const out = [];
  for (const { template, version } of rows) {
    const def = TemplateDefinition.parse(version.definition);
    out.push({ id: template.id, builtin: template.builtin, version: version.version, name: def.name, description: def.description, family: def.family, preset: def.preset ?? null, tags: def.tags, defaultAspect: def.defaultAspect, supportedAspects: def.supportedAspects, duration: def.duration, providers: def.providers, availability: await templateAvailability(def, s.workspaceId), previewAssetId: version.previewAssetId });
  }
  return json({ templates: out });
});
