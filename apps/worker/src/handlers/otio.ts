import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, getRevision, JobError, schema } from "@vs/db";
import { ProjectDocument } from "@vs/domain";
import { buildOtio, runOk, type OtioMedia } from "@vs/rendering";
import { registerFile, resolveAssets, type Handler } from "../context";

const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);

/**
 * OpenTimelineIO export (Phase 4): bundle the rendered program, voiceover, music and footage
 * with an OTIO timeline as an .otioz package (content.otio + media/), which Resolve, Premiere
 * (via OTIO) and other editors open with media linked. Needs a render of the revision.
 */
export const exportOtio: Handler = async (ctx) => {
  const db = getDb();
  const projectId = ctx.job.projectId!;
  const revisionId = ctx.job.revisionId!;
  const doc = ProjectDocument.parse((await getRevision(db, projectId, revisionId)).document);
  const exports = await db.query.exportsTable.findMany({ where: and(eq(schema.exportsTable.projectId, projectId), eq(schema.exportsTable.revisionId, revisionId)), orderBy: desc(schema.exportsTable.createdAt) });
  const render = exports.find((e) => e.kind === "final") ?? exports[0];
  if (!render) throw new JobError("render_required", "This version has not been rendered yet.", false, "Render a draft (or export) of this version first; the OTIO timeline cuts the rendered program.");

  await ctx.stage("collecting media");
  const dir = join(ctx.workDir, "otioz");
  await mkdir(join(dir, "media"), { recursive: true });
  const ids = new Set<string>([render.videoAssetId]);
  for (const t of doc.audio) ids.add(t.assetId);
  for (const s of doc.scenes) for (const l of s.layers) if (l.kind === "video" && !l.hidden && l.assetId) ids.add(l.assetId);
  const files = await resolveAssets(ctx.job.workspaceId, [...ids]);
  const rows = await db.query.assets.findMany({ where: and(eq(schema.assets.workspaceId, ctx.job.workspaceId), inArray(schema.assets.id, [...ids])) });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const media: OtioMedia = { program: { path: "", frames: Math.round(render.durationSec * doc.format.fps) }, assets: {} };
  const used = new Set<string>();
  for (const id of ids) {
    const f = files.get(id)!;
    const row = byId.get(id);
    const original = row?.originalName ?? id;
    let name = id === render.videoAssetId ? `program${extname(f.path) || ".mp4"}` : `${safe(basename(original, extname(original)))}${extname(f.path)}`;
    if (used.has(name)) name = `${id}-${name}`;
    used.add(name);
    await copyFile(f.path, join(dir, "media", name));
    const rel = `media/${name}`;
    if (id === render.videoAssetId) media.program.path = rel;
    else media.assets[id] = { path: rel, durationSec: Number((row?.media as { durationSec?: number } | undefined)?.durationSec ?? 0) || null };
  }

  await ctx.stage("writing timeline");
  const otio = buildOtio(doc, media, { projectId, revisionId, width: render.width, height: render.height });
  await writeFile(join(dir, "content.otio"), JSON.stringify(otio, null, 2));
  await writeFile(join(dir, "version.txt"), "1.0.0");
  const out = join(ctx.workDir, `${safe(doc.title) || "project"}.otioz`);
  // Stored, not deflated: media is already compressed, and editors read .otioz faster that way.
  await runOk("zip", ["-q", "-0", "-X", "-r", out, "content.otio", "version.txt", "media"], { cwd: dir, timeoutMs: 10 * 60_000 });
  const asset = await registerFile(ctx.job.workspaceId, out, { kind: "other", originalName: basename(out), mime: "application/zip", provenance: { source: "otio-export", jobId: ctx.job.id, revisionId, exportId: render.id }, probe: false });
  return { assetId: asset.id, renderKind: render.kind, tracks: (otio.tracks as { children: unknown[] }).children.length, mediaFiles: ids.size };
};
