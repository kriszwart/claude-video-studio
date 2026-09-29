import { join } from "node:path";
import { getDb, getRevision } from "@vs/db";
import { computeTimeline, ProjectDocument } from "@vs/domain";
import { captureStills, prepareBundle } from "@vs/rendering";
import { referencedAssetIds, registerFile, resolveAssets, type Handler } from "../context";
import { graphicsCompilerFor } from "../graphics";

/** Storyboard keyframes: actual frames captured from the compiled composition (FR-05). */
export const renderKeyframes: Handler = async (ctx) => {
  const db = getDb();
  const revision = await getRevision(db, ctx.job.projectId!, ctx.job.revisionId!);
  const doc = ProjectDocument.parse(revision.document);
  await ctx.stage("compiling");
  const assets = await resolveAssets(ctx.job.workspaceId, referencedAssetIds(doc));
  const b = await prepareBundle(
    { doc, assets, workDir: ctx.workDir, output: "", scale: Number(ctx.job.input.scale ?? 0.35), quality: "draft", signal: ctx.signal, graphics: await graphicsCompilerFor(doc, ctx) },
    { withAudio: false },
  );
  const timeline = computeTimeline(doc);
  const times = timeline.scenes.map((s, i) => {
    const scene = doc.scenes[i]!;
    const off = scene.keyframeOffset ?? Math.round(s.duration * 0.62);
    return (s.start + Math.min(off, s.duration - 1)) / doc.format.fps;
  });
  await ctx.stage("capturing keyframes", 0);
  const stills = await captureStills({ bundleDir: b.bundleDir, width: b.width, height: b.height, times, outPath: (i) => join(ctx.workDir, `kf-${i}.jpg`), signal: ctx.signal });
  const keyframes = [];
  for (const [i, file] of stills.files.entries()) {
    const a = await registerFile(ctx.job.workspaceId, file, { kind: "image", originalName: `keyframe-${i + 1}.jpg`, mime: "image/jpeg", provenance: { source: "keyframe", revisionId: revision.id, sceneId: doc.scenes[i]!.id, timeSec: times[i] } });
    keyframes.push({ sceneId: doc.scenes[i]!.id, assetId: a.id, timeSec: times[i] });
    await ctx.stage("capturing keyframes", (i + 1) / stills.files.length);
  }
  return { revisionId: revision.id, keyframes, report: stills.report, bundleHash: b.bundleHash };
};
