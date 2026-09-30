import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, getDb, getRevision, JobError } from "@vs/db";
import { GraphicsUnavailableError } from "@vs/compositor";
import { computeTimeline, ProjectDocument, stableStringify } from "@vs/domain";
import { getHyperframeRuntimeScript } from "@hyperframes/core/runtime-script";
import { prepareBundle, RENDERER_VERSIONS } from "@vs/rendering";
import { referencedAssetIds, resolveAssets, type Handler } from "../context";
import { graphicsCompilerFor } from "../graphics";
import { programMixInputs } from "../program";

export const LIVE_SCALE = 0.5;

/** Where a revision's live bundle lives (DATA_DIR/live/<key>/bundle). Immutable revision → stable key. */
export function liveKey(revisionId: string, graphicsVersions: Record<string, unknown> = {}): string {
  return createHash("sha256").update(stableStringify({ v: 1, revisionId, renderer: RENDERER_VERSIONS, graphics: graphicsVersions, scale: LIVE_SCALE })).digest("hex").slice(0, 24);
}

/**
 * Live preview (editor player): the same compiled composition and audio mix the exporter
 * uses, staged as a browser-playable bundle — no frame capture or encode. The editor plays it
 * in an iframe through the HyperFrames runtime, so what you scrub is what renders. Bundles are
 * cached per revision; the audio mix is cached by its inputs so text/layout edits don't re-mix.
 */
export const livePreview: Handler = async (ctx) => {
  const db = getDb();
  const revision = await getRevision(db, ctx.job.projectId!, ctx.job.revisionId!);
  const doc = ProjectDocument.parse(revision.document);
  const graphics = await graphicsCompilerFor(doc, ctx);
  const key = liveKey(revision.id, graphics?.versions ?? {});
  const root = join(dataDir(), "live");
  const dir = join(root, key);
  const metaFile = join(dir, "live.json");
  try {
    await stat(join(dir, "bundle", "index.html"));
    const now = new Date();
    await utimes(dir, now, now).catch(() => {}); // keep in-use bundles from being pruned
    return { ...(JSON.parse(await readFile(metaFile, "utf8")) as Record<string, unknown>), cached: true };
  } catch {
    /* build it */
  }
  await ctx.stage("staging");
  const assets = await resolveAssets(ctx.job.workspaceId, referencedAssetIds(doc), { preferProxy: true });
  const tmp = `${dir}.tmp-${ctx.job.id}`;
  await rm(tmp, { recursive: true, force: true });
  let b;
  try {
    b = await prepareBundle(
      { doc, assets, workDir: tmp, output: "", scale: LIVE_SCALE, quality: "draft", signal: ctx.signal, graphics, extraMix: programMixInputs(doc, assets) },
      { withAudio: true, mixCacheDir: join(root, "mix") },
    );
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    if (e instanceof GraphicsUnavailableError) throw new JobError("graphics_unavailable", e.message, false, "Live preview needs a worker with this graphics backend; use Render draft instead.");
    throw e;
  }
  // The player page: the exporter's preview page (composition + embedded mix) plus the
  // HyperFrames runtime, which mounts clips, syncs media and drives the timeline for the player.
  const bundleDir = join(tmp, "bundle");
  const page = await readFile(join(bundleDir, "preview.html"), "utf8");
  await mkdir(join(bundleDir, "vendor"), { recursive: true });
  await writeFile(join(bundleDir, "vendor", "hf-runtime.js"), getHyperframeRuntimeScript());
  await writeFile(join(bundleDir, "index.html"), page.replace(/<\/body>\s*<\/html>\s*$/, `<script src="vendor/hf-runtime.js"></script>\n</body></html>`));
  const timeline = computeTimeline(doc);
  const meta = {
    key,
    revisionId: revision.id,
    width: b.width,
    height: b.height,
    fps: b.fps,
    durationSec: timeline.totalFrames / doc.format.fps,
    scenes: timeline.scenes.map((s, i) => ({ sceneId: doc.scenes[i]!.id, startSec: s.start / doc.format.fps, durationSec: s.duration / doc.format.fps })),
    warnings: b.warnings,
    builtAt: new Date().toISOString(),
  };
  await writeFile(join(tmp, "live.json"), JSON.stringify(meta));
  await mkdir(root, { recursive: true });
  // Atomic publish: a concurrent build of the same revision just loses the rename race.
  await rename(tmp, dir).catch(async () => rm(tmp, { recursive: true, force: true }));
  return { ...meta, cached: false };
};
