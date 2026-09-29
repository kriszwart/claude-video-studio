import { createHash } from "node:crypto";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { getDb, getRevision, keyframeHash, schema } from "@vs/db";
import { computeTimeline, ProjectDocument, stableStringify, type Scene } from "@vs/domain";
import { captureStills, prepareBundle, RENDERER_VERSIONS } from "@vs/rendering";
import { referencedAssetIds, registerFile, resolveAssets, type Handler } from "../context";
import { graphicsCompilerFor, needsWebGpu } from "../graphics";

/** A scene's look without its identifiers (ids don't change pixels; template reuse gets new ids). */
function normalizedScene(scene: Scene) {
  const { id: _id, ...rest } = scene;
  return { ...rest, layers: scene.layers.map(({ id: _l, ...l }) => l) };
}

/**
 * Storyboard keyframes: actual frames captured from the compiled composition (FR-05).
 * Frames are cached per scene by everything that affects their pixels — normalised scene
 * content, format, brand, profile, program state, the content hashes of the scene's assets,
 * capture scale, and the renderer/graphics build versions (FR-21, A30). A parameter edit
 * re-renders only the scenes it changed; identical scenes reuse the stored frame.
 */
export const renderKeyframes: Handler = async (ctx) => {
  const db = getDb();
  const revision = await getRevision(db, ctx.job.projectId!, ctx.job.revisionId!);
  const doc = ProjectDocument.parse(revision.document);
  const scale = Number(ctx.job.input.scale ?? 0.35);
  const assets = await resolveAssets(ctx.job.workspaceId, referencedAssetIds(doc));
  const graphics = await graphicsCompilerFor(doc, ctx);
  const timeline = computeTimeline(doc);
  const times = timeline.scenes.map((s, i) => {
    const scene = doc.scenes[i]!;
    const off = scene.keyframeOffset ?? Math.round(s.duration * 0.62);
    return (s.start + Math.min(off, s.duration - 1)) / doc.format.fps;
  });
  const keys = doc.scenes.map((scene, i) => {
    const sceneAssets = referencedAssetIds({ ...doc, scenes: [scene], audio: [], characters: doc.characters } as ProjectDocument)
      .map((id) => assets.get(id)?.contentHash ?? id)
      .sort();
    const program = doc.program ? { edl: doc.program.edl, framing: doc.program.presenterFraming, start: timeline.scenes[i]!.start, beats: doc.beats, captions: doc.captions } : null;
    const captionsHere = doc.program ? null : doc.captions.enabled ? doc.captions.cues.filter((c) => c.anchor.type === "scene" && c.anchor.sceneId === scene.id).map(({ id: _c, anchor: _a, ...c }) => c) : null;
    return createHash("sha256")
      .update(stableStringify({ v: "kf/1", scene: normalizedScene(scene), offsetFrames: Math.round(times[i]! * doc.format.fps) - timeline.scenes[i]!.start, format: doc.format, brand: doc.brand, profile: doc.profile, characters: doc.characters, program, captions: captionsHere, captionStyle: doc.captions.enabled ? { style: doc.captions.style, position: doc.captions.position } : null, sceneAssets, scale, renderer: RENDERER_VERSIONS, graphics: graphics?.versions ?? {} }))
      .digest("hex");
  });
  const cached = keys.length ? await db.query.graphicsCache.findMany({ where: inArray(schema.graphicsCache.key, keys) }) : [];
  const hit = new Map(cached.filter((c) => c.workspaceId === ctx.job.workspaceId).map((c) => [c.key, c.assetId]));
  // Cached frames must still exist (assets can be purged); missing ones are re-rendered.
  const alive = hit.size ? await db.query.assets.findMany({ where: inArray(schema.assets.id, [...hit.values()]), columns: { id: true, status: true } }) : [];
  for (const [key, assetId] of hit) if (!alive.some((a) => a.id === assetId && a.status === "ready")) hit.delete(key);
  const misses = doc.scenes.map((_, i) => i).filter((i) => !hit.has(keys[i]!));

  let report: unknown = null;
  let bundleHash: string | null = null;
  const rendered = new Map<number, string>();
  if (misses.length) {
    await ctx.stage("compiling");
    const b = await prepareBundle({ doc, assets, workDir: ctx.workDir, output: "", scale, quality: "draft", signal: ctx.signal, graphics }, { withAudio: false });
    bundleHash = b.bundleHash;
    await ctx.stage("capturing keyframes", 0);
    const stills = await captureStills({ bundleDir: b.bundleDir, width: b.width, height: b.height, times: misses.map((i) => times[i]!), outPath: (k) => join(ctx.workDir, `kf-${misses[k]}.jpg`), signal: ctx.signal, webgpu: needsWebGpu(doc) });
    report = stills.report;
    for (const [k, file] of stills.files.entries()) {
      const i = misses[k]!;
      const a = await registerFile(ctx.job.workspaceId, file, { kind: "image", originalName: `keyframe-${i + 1}.jpg`, mime: "image/jpeg", provenance: { source: "keyframe", revisionId: revision.id, sceneId: doc.scenes[i]!.id, timeSec: times[i] } });
      rendered.set(i, a.id);
      await db
        .insert(schema.graphicsCache)
        .values({ key: keys[i]!, workspaceId: ctx.job.workspaceId, backend: "keyframe", assetId: a.id, meta: { sceneId: doc.scenes[i]!.id, revisionId: revision.id, graphics: graphics?.versions ?? {}, renderer: RENDERER_VERSIONS, scale } })
        .onConflictDoUpdate({ target: schema.graphicsCache.key, set: { assetId: a.id } });
      await ctx.stage("capturing keyframes", (k + 1) / stills.files.length);
    }
  }
  const keyframes = doc.scenes.map((scene, i) => ({ sceneId: scene.id, assetId: rendered.get(i) ?? hit.get(keys[i]!)!, timeSec: times[i], sceneHash: keyframeHash(doc, scene.id), cacheKey: keys[i]!.slice(0, 16), cached: !rendered.has(i) }));
  return { revisionId: revision.id, keyframes, rendered: rendered.size, reused: doc.scenes.length - rendered.size, report, bundleHash };
};
