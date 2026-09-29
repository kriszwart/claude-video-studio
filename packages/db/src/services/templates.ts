import { createHash } from "node:crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { stableStringify } from "@vs/domain";
import type { DbOrTx } from "../client";
import { AppError, notFound } from "../errors";
import { newId } from "../ids";
import { templates, templateVersions } from "../schema";

export interface TemplateLike {
  id: string;
  family: string;
  preset?: string;
  name: string;
  description: string;
  version: number;
}

export function hashDefinition(def: unknown) {
  return createHash("sha256").update(stableStringify(def)).digest("hex");
}

/**
 * Publish built-in template definitions. Versions are immutable: a changed definition
 * under an existing version number is refused, so projects pinned to it never change.
 */
export async function syncBuiltinTemplates(db: DbOrTx, defs: TemplateLike[]) {
  for (const def of defs) {
    const hash = hashDefinition(def);
    await db
      .insert(templates)
      .values({ id: def.id, workspaceId: null, family: def.family, preset: def.preset ?? null, name: def.name, description: def.description, builtin: true, latestVersion: def.version })
      .onConflictDoUpdate({ target: templates.id, set: { name: def.name, description: def.description, latestVersion: def.version, preset: def.preset ?? null } });
    const existing = await db.query.templateVersions.findFirst({ where: and(eq(templateVersions.templateId, def.id), eq(templateVersions.version, def.version)) });
    if (!existing) {
      await db.insert(templateVersions).values({ id: newId("tpv"), templateId: def.id, version: def.version, definition: def, definitionHash: hash });
    } else if (existing.definitionHash !== hash) {
      if (process.env.ALLOW_BUILTIN_TEMPLATE_REWRITE === "1") {
        await db.update(templateVersions).set({ definition: def, definitionHash: hash }).where(eq(templateVersions.id, existing.id));
      } else {
        throw new Error(`Built-in template ${def.id}@${def.version} changed without a version bump. Increase its version.`);
      }
    }
  }
}

export async function listTemplates(db: DbOrTx, workspaceId: string) {
  const rows = await db.query.templates.findMany({
    where: and(or(isNull(templates.workspaceId), eq(templates.workspaceId, workspaceId)), eq(templates.archived, false)),
    orderBy: [desc(templates.builtin), templates.name],
  });
  const out = [];
  for (const t of rows) {
    const v = await db.query.templateVersions.findFirst({ where: and(eq(templateVersions.templateId, t.id), eq(templateVersions.version, t.latestVersion)) });
    if (v) out.push({ template: t, version: v });
  }
  return out;
}

export async function getTemplateVersion(db: DbOrTx, workspaceId: string, templateId: string, version?: number) {
  const t = await db.query.templates.findFirst({ where: and(eq(templates.id, templateId), or(isNull(templates.workspaceId), eq(templates.workspaceId, workspaceId))) });
  if (!t) throw notFound("Template");
  const v = await db.query.templateVersions.findFirst({ where: and(eq(templateVersions.templateId, templateId), eq(templateVersions.version, version ?? t.latestVersion)) });
  if (!v) throw notFound("Template version");
  return { template: t, version: v };
}

export async function publishUserTemplate(
  db: DbOrTx,
  workspaceId: string,
  def: TemplateLike & Record<string, unknown>,
  opts: { existingTemplateId?: string; previewAssetId?: string } = {},
) {
  if (opts.existingTemplateId) {
    const t = await db.query.templates.findFirst({ where: and(eq(templates.id, opts.existingTemplateId), eq(templates.workspaceId, workspaceId)) });
    if (!t) throw notFound("Template");
    const version = t.latestVersion + 1;
    const d = { ...def, id: t.id, version };
    await db.insert(templateVersions).values({ id: newId("tpv"), templateId: t.id, version, definition: d, definitionHash: hashDefinition(d), previewAssetId: opts.previewAssetId });
    await db.update(templates).set({ latestVersion: version, name: def.name, description: def.description }).where(eq(templates.id, t.id));
    return { templateId: t.id, version };
  }
  const id = `u-${newId("tpl").slice(4, 20)}`;
  const d = { ...def, id, version: 1 };
  await db.insert(templates).values({ id, workspaceId, family: def.family, preset: def.preset ?? null, name: def.name, description: def.description, builtin: false, latestVersion: 1 });
  await db.insert(templateVersions).values({ id: newId("tpv"), templateId: id, version: 1, definition: d, definitionHash: hashDefinition(d), previewAssetId: opts.previewAssetId });
  return { templateId: id, version: 1 };
}

export async function archiveTemplate(db: DbOrTx, workspaceId: string, templateId: string) {
  const [row] = await db.update(templates).set({ archived: true }).where(and(eq(templates.id, templateId), eq(templates.workspaceId, workspaceId))).returning();
  if (!row) throw new AppError(404, "not_found", "Only your own templates can be archived.");
}
