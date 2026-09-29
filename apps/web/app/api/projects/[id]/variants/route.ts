import { z } from "zod";
import { AppError, createProject, getDb, getProject, getTemplateVersion, getTranscript, newId, schema } from "@vs/db";
import { correctedSegments, ProjectDocument } from "@vs/domain";
import { buildProgramScenes, PROFILE_PRESETS, TemplateDefinition } from "@vs/templates";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";
import { projectView } from "@/lib/server/projects";

const STYLES = {
  whiteboard: { templateId: "whiteboard-explainer", aspect: "16:9", label: "Whiteboard", profile: undefined },
  course: { templateId: "course-lesson", aspect: "16:9", label: "Course", profile: undefined },
  social: { templateId: "talking-head", aspect: "9:16", label: "Social", profile: "fast-social" },
  "presenter-intro": { templateId: "presenter-intro", aspect: "16:9", label: "Presenter intro", profile: undefined },
} as const;

/**
 * Create an independent style variant of a talking-head project (A18). The source asset,
 * immutable transcript and owner corrections are shared by reference — nothing is
 * re-uploaded or re-transcribed — while the new document is a separate project, so
 * editing one variant never touches another.
 */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ style: z.enum(["whiteboard", "course", "social", "presenter-intro"]), title: z.string().min(1).max(160).optional() }));
  const db = getDb();
  const { project, doc } = await getProject(db, id, s.workspaceId);
  const p = doc.program;
  if (!p?.transcriptId) throw new AppError(409, "no_transcript", "Transcribe the recording before creating style variants.");
  const cfg = STYLES[b.style];
  const { version } = await getTemplateVersion(db, s.workspaceId, cfg.templateId);
  const def = TemplateDefinition.parse(version.definition);
  const t = await getTranscript(db, p.transcriptId, s.workspaceId);
  const src = await db.query.assets.findFirst({ where: eq(schema.assets.id, p.sourceAssetId) });
  const dur = Number((src?.media as { durationSec?: number })?.durationSec ?? 0);
  const profile = cfg.profile ? { ...PROFILE_PRESETS[cfg.profile]! } : { ...doc.profile, ...def.profile };
  const base = ProjectDocument.parse({
    ...doc,
    title: b.title ?? `${doc.title} — ${cfg.label}`,
    template: { templateId: def.id, version: def.version, family: def.family, preset: def.preset },
    format: { ...doc.format, aspect: cfg.aspect },
    profile,
    // Same kept material and corrections; fresh style-specific scenes, captions and inserts.
    program: { ...p, style: b.style === "presenter-intro" ? "presenter-intro" : b.style, presenterFraming: def.program?.presenterFraming ?? "full", proposedCuts: [] },
    beats: [],
  });
  const bRollInput = def.program?.bRollInput;
  const bRoll = bRollInput ? ([] as string[]).concat((doc.brief.inputs[bRollInput] as string[] | string | undefined) ?? []) : [];
  const built = buildProgramScenes(base, { segments: correctedSegments(t.segments, p.corrections), sourceDurationSec: dur, newId, bRollAssetIds: bRoll, resetBeats: true });
  const groupId = project.variantGroupId ?? project.id;
  const created = await db.transaction(async (tx) => {
    if (!project.variantGroupId) await tx.update(schema.projects).set({ variantGroupId: groupId, variantLabel: project.variantLabel ?? "Original" }).where(eq(schema.projects.id, project.id));
    return createProject(tx, { workspaceId: s.workspaceId, doc: built, templateId: def.id, templateVersion: def.version, family: def.family, variantGroupId: groupId, variantLabel: cfg.label, author: "user", action: `${cfg.label} variant of ${project.title}` });
  });
  return json({ ...(await projectView(created.project.id, s.workspaceId)), sharedTranscriptId: p.transcriptId, sharedSourceAssetId: p.sourceAssetId }, 201);
});

/** List sibling variants. */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const db = getDb();
  const { project } = await getProject(db, id, s.workspaceId);
  const group = project.variantGroupId;
  if (!group) return json({ variants: [{ id: project.id, title: project.title, label: project.variantLabel ?? "Original" }] });
  const rows = await db.query.projects.findMany({ where: (x, { and, eq, ne }) => and(eq(x.variantGroupId, group), eq(x.workspaceId, s.workspaceId), ne(x.status, "deleted")) });
  return json({ variants: rows.map((r) => ({ id: r.id, title: r.title, label: r.variantLabel ?? "Original" })) });
});
