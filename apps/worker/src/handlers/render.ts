import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, getRevision, JobError, newId, schema } from "@vs/db";
import { GraphicsUnavailableError } from "@vs/compositor";
import { AspectRatio, computeTimeline, ProjectDocument, toSrt, toVtt, validateTimeline } from "@vs/domain";
import { extractFrame, renderProject } from "@vs/rendering";
import { referencedAssetIds, registerFile, resolveAssets, type Handler } from "../context";
import { graphicsCompilerFor, needsWebGpu } from "../graphics";
import { programMixInputs } from "../program";

/**
 * Render an immutable revision. "preview" = half-resolution draft, "final" = 1080p export (or 4K
 * when the export asks for it).
 * Publishing is idempotent per job: a retried job that already published returns the
 * existing export instead of creating a duplicate (A07).
 */
export const renderRevision: Handler = async (ctx) => {
  const db = getDb();
  const kind = ctx.job.type === "export" ? "final" : "preview";
  const existing = await db.query.exportsTable.findFirst({ where: eq(schema.exportsTable.jobId, ctx.job.id) });
  if (existing) return { exportId: existing.id, videoAssetId: existing.videoAssetId, reused: true };

  const revisionId = ctx.job.revisionId!;
  const revision = await getRevision(db, ctx.job.projectId!, revisionId);
  const saved = ProjectDocument.parse(revision.document);
  // An extra export size renders the same revision in another aspect; layouts adapt per aspect.
  const aspect = AspectRatio.safeParse(ctx.job.input.aspect);
  const sized = aspect.success && aspect.data !== saved.format.aspect;
  const doc: ProjectDocument = sized ? { ...saved, format: { ...saved.format, aspect: aspect.data } } : saved;
  const hard = validateTimeline(doc).filter((i) => i.severity === "error");
  if (hard.length) throw new JobError("invalid_timeline", hard.map((i) => i.message).join(" "), false, "Fix the listed timeline problems and render again.");

  await ctx.stage("staging assets");
  const assets = await resolveAssets(ctx.job.workspaceId, referencedAssetIds(doc));
  const fourK = kind === "final" && ctx.job.input.resolution === "4k";
  const scale = kind === "final" ? (fourK ? 2 : 1) : Number(process.env.PREVIEW_SCALE ?? 0.5);
  const output = join(ctx.workDir, `${kind}.mp4`);
  let result;
  try {
    result = await renderProject({
      doc,
      assets,
      workDir: ctx.workDir,
      output,
      scale,
      quality: kind === "final" ? "standard" : "draft",
      signal: ctx.signal,
      graphics: await graphicsCompilerFor(doc, ctx),
      webgpu: needsWebGpu(doc),
      extraMix: programMixInputs(doc, assets),
      onProgress: async (stage, fraction, message) => {
        await ctx.stage(stage, fraction, { message });
      },
    });
  } catch (e) {
    if (e instanceof GraphicsUnavailableError) throw new JobError("graphics_unavailable", e.message, false, "Choose a compatible worker or a tested fallback component; blank layers are never published.");
    throw e;
  }

  if (!result.verification.ok) {
    const failed = result.verification.checks.filter((c) => c.severity === "hard" && !c.ok);
    throw new JobError("verification_failed", `The rendered file failed verification: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}`, true);
  }

  await ctx.stage("publishing");
  const timeline = computeTimeline(doc);
  const video = await registerFile(ctx.job.workspaceId, output, {
    kind: "render",
    originalName: `${slug(doc.title)}-${kind}${sized ? `-${doc.format.aspect.replace(":", "x")}` : ""}${fourK ? "-4k" : ""}-r${revision.seq}.mp4`,
    mime: "video/mp4",
    provenance: { source: "render", kind, projectId: ctx.job.projectId, revisionId, jobId: ctx.job.id, bundleHash: result.bundleHash },
  });
  const thumbPath = join(ctx.workDir, "thumb.jpg");
  const firstScene = timeline.scenes[0]!;
  await extractFrame(output, Math.min(result.totalFrames / 30 - 0.05, (firstScene.start + Math.min(firstScene.duration - 1, 45)) / 30), thumbPath, 640);
  const thumb = await registerFile(ctx.job.workspaceId, thumbPath, { kind: "image", originalName: `${slug(doc.title)}-thumb.jpg`, mime: "image/jpeg", provenance: { source: "render-thumbnail", jobId: ctx.job.id, revisionId } });

  let srtId: string | undefined;
  let vttId: string | undefined;
  if (kind === "final" && doc.captions.cues.length > 0) {
    const srt = join(ctx.workDir, "captions.srt");
    const vtt = join(ctx.workDir, "captions.vtt");
    await writeFile(srt, toSrt(doc));
    await writeFile(vtt, toVtt(doc));
    srtId = (await registerFile(ctx.job.workspaceId, srt, { kind: "document", originalName: `${slug(doc.title)}.srt`, mime: "application/x-subrip", provenance: { source: "captions", revisionId }, probe: false })).id;
    vttId = (await registerFile(ctx.job.workspaceId, vtt, { kind: "document", originalName: `${slug(doc.title)}.vtt`, mime: "text/vtt", provenance: { source: "captions", revisionId }, probe: false })).id;
  }

  const exportId = newId("exp");
  await db
    .insert(schema.exportsTable)
    .values({
      id: exportId,
      workspaceId: ctx.job.workspaceId,
      projectId: ctx.job.projectId!,
      revisionId,
      jobId: ctx.job.id,
      kind,
      videoAssetId: video.id,
      thumbnailAssetId: thumb.id,
      captionsSrtAssetId: srtId,
      captionsVttAssetId: vttId,
      width: result.width,
      height: result.height,
      durationSec: result.totalFrames / result.fps,
      bundleHash: result.bundleHash,
      verification: { ...result.verification, mix: result.mix, warnings: result.warnings, timingsMs: result.timingsMs, manifest: result.manifest },
    })
    .onConflictDoNothing({ target: schema.exportsTable.jobId });
  const row = await db.query.exportsTable.findFirst({ where: and(eq(schema.exportsTable.jobId, ctx.job.id)) });
  return {
    exportId: row!.id,
    videoAssetId: row!.videoAssetId,
    thumbnailAssetId: row!.thumbnailAssetId,
    bundleHash: result.bundleHash,
    warnings: result.warnings,
    loudness: result.verification.loudness,
    timingsMs: result.timingsMs,
  };
};

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "video";
}
