import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError, applyProjectOperations, getDb, getProject, JobError } from "@vs/db";
import { demoTail, maxDemoSteps, spaceDemoSteps, type Operation } from "@vs/domain";
import { runDemoPlanner, type ClaudeEffort } from "@vs/providers";
import { FFMPEG, runOk } from "@vs/rendering";
import { resolveAssets, type Handler } from "../context";
import { claudeFor, noteLimit, recordUsage, toJobError } from "./ai";

/**
 * Plan a screen demo: Claude picks the controls on the real screenshot a cursor should work
 * through; the steps are spaced evenly through the scene and saved as an ordinary edit (undoable,
 * and editable in the Scene tab).
 */
export const planDemo: Handler = async (ctx) => {
  const db = getDb();
  const projectId = ctx.job.projectId!;
  const sceneId = String(ctx.job.input.sceneId ?? "");
  const { doc } = await getProject(db, projectId, ctx.job.workspaceId);
  const scene = doc.scenes.find((s) => s.id === sceneId);
  if (!scene?.demo) throw new JobError("invalid_input", "That scene is not a screen demo.", false, "Choose the screenshot for a screen demo in the Scene tab first.");
  if (scene.locked) throw new JobError("scene_locked", "The scene is locked.", false, "Unlock it to plan its demo.");
  const layer = scene.layers.find((l) => l.id === scene.demo!.layerId);
  const assetId = layer && (layer.kind === "image" || layer.kind === "video") ? layer.assetId : null;
  if (!assetId) throw new JobError("invalid_input", "The demo has no screenshot.", false, "Choose a screenshot for the demo's image layer.");
  const file = (await resolveAssets(ctx.job.workspaceId, [assetId])).get(assetId)!;
  if (file.kind !== "image") throw new JobError("invalid_input", "Screen demos are planned on a screenshot (an image).", false);
  const client = await claudeFor(ctx.job.workspaceId, projectId);

  await ctx.stage("Claude is reading the screen");
  const small = join(ctx.workDir, "screen.jpg");
  await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", file.path, "-vf", "scale='min(1600,iw)':-2", "-frames:v", "1", "-q:v", "3", small], { timeoutMs: 60_000 });
  const headline = scene.layers.find((l) => l.kind === "text" && l.role === "headline");
  const b = doc.brief;
  const product = [b.productName && `Product: ${b.productName}`, b.promise && `Promise: ${b.promise}`, b.benefits.length && `Benefits: ${b.benefits.join("; ")}`, b.audience && `Audience: ${b.audience}`].filter(Boolean).join("\n") || doc.title;
  let run;
  try {
    run = await runDemoPlanner(client, { product, focus: headline && headline.kind === "text" ? headline.text : scene.purpose, image: { mediaType: "image/jpeg", data: (await readFile(small)).toString("base64"), width: Number(file.media.width ?? 0), height: Number(file.media.height ?? 0) }, maxSteps: maxDemoSteps(scene.durationFrames, doc.format.fps, scene.demo.zoomOut, demoTail(doc, scene.id)) }, { signal: ctx.signal, effort: (ctx.job.input.effort as ClaudeEffort | undefined) ?? "medium" });
  } catch (e) {
    await noteLimit(ctx.job.workspaceId, e);
    throw toJobError(e);
  }
  await noteLimit(ctx.job.workspaceId, null, run.usage);
  await recordUsage(ctx.job.workspaceId, projectId, ctx.job.id, run.usage, "demo-plan");

  for (let attempt = 0; attempt < 3; attempt++) {
    const { doc: cur, revision } = await getProject(db, projectId, ctx.job.workspaceId);
    const sc = cur.scenes.find((s) => s.id === sceneId);
    if (!sc?.demo) throw new JobError("scene_changed", "The scene stopped being a screen demo while Claude was planning.", false);
    const times = spaceDemoSteps(run.output.steps.length, sc.durationFrames, cur.format.fps, sc.demo.zoomOut, demoTail(cur, sceneId));
    const steps = run.output.steps.map((s, i) => ({ x: s.x, y: s.y, zoom: s.zoom, action: s.action, label: s.label, atFrames: times[i]! }));
    const ops: Operation[] = [{ op: "setSceneDemo", sceneId, demo: { ...sc.demo, steps } }];
    try {
      await db.transaction((tx) => applyProjectOperations(tx, { projectId, workspaceId: ctx.job.workspaceId, baseRevisionId: revision.id, ops, actor: "system", author: "system", action: `screen demo planned by Claude (${steps.length} steps)` }));
      return { steps: steps.length, summary: run.output.summary, plan: run.output.steps };
    } catch (e) {
      if (!(e instanceof AppError && e.status === 409)) throw e;
    }
  }
  throw new JobError("stale_revision", "The project kept changing while the demo was saved; plan it again.", false);
};
