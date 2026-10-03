import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { computeTimeline, type ProjectDocument } from "@vs/domain";
import { apiUpload, createProject, downloadAndProbe, FIX, frameAt, renderAndWait } from "./helpers";

/**
 * Skia shader effects (SkSL on a shared WebGL surface): each one in its own scene of a real render.
 * Every effect draws something (not blank), moves over time, and the render is repeatable.
 */
const view = async (request: APIRequestContext, id: string) => (await request.get(`/api/projects/${id}`)).json();
const ops = async (request: APIRequestContext, id: string, o: unknown[]) => {
  const v = await view(request, id);
  const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: o } });
  expect(r.status(), await r.text()).toBe(200);
};
/** Mean absolute difference (0–255) between two frames, and a frame's spread of brightness. */
const grey = (f: string) => execFileSync("ffmpeg", ["-v", "error", "-i", f, "-vf", "scale=96:54,format=gray", "-f", "rawvideo", "-"]);
const diff = (a: string, b: string) => {
  const x = grey(a), y = grey(b);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += Math.abs(x[i]! - y[i]!);
  return s / x.length;
};
const spread = (f: string) => {
  const x = [...grey(f)].sort((a, b) => a - b);
  return x[Math.floor(x.length * 0.95)]! - x[Math.floor(x.length * 0.05)]!;
};

const EFFECTS = [
  { id: "mesh-gradient", params: {}, full: true },
  { id: "aurora", params: {}, full: true },
  { id: "metaballs", params: {}, full: false },
  { id: "liquid-morph", params: { holdSec: 0.4, morphSec: 0.8 }, full: false },
  { id: "glass-lens", params: { path: "sweep" }, full: true },
];

test("each Skia shader effect renders, moves and is repeatable", async ({ page, request }) => {
  test.setTimeout(30 * 60_000);
  const shot = await apiUpload(request, join(FIX, "tidewave-dashboard.png"), "image/png");
  const { project } = await createProject(request, { templateId: "motion-reel", title: "Shader effects", inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave" } });
  const id = project.id;
  let doc = (await view(request, id)).doc as ProjectDocument;
  for (let k = doc.scenes.length; k < EFFECTS.length; k++) await ops(request, id, [{ op: "duplicateScene", sceneId: doc.scenes[0]!.id, newSceneId: `scn_fx${k}` }]);
  doc = (await view(request, id)).doc;
  const seed = 11 + (Date.now() % 10_000);
  await ops(
    request,
    id,
    EFFECTS.flatMap((e, i) => {
      const s = doc.scenes[i]!;
      return [
        // Only the effect on screen in these scenes: the frame shows what it draws.
        ...s.layers.map((l) => ({ op: "setLayerHidden", sceneId: s.id, layerId: l.id, hidden: true })),
        { op: "setSceneBackground", sceneId: s.id, background: { type: "color", color: "#101014" } },
        { op: "setSceneDuration", sceneId: s.id, durationFrames: 75 },
        { op: "addLayer", sceneId: s.id, layer: { id: `fx${i}`, slot: "decor", hidden: false, kind: "graphics", backend: "skia", component: e.id, componentVersion: 1, params: { ...e.params, ...(e.id === "glass-lens" ? { image: shot } : {}) }, seed, box: e.full ? { x: 0, y: 0, w: 1, h: 1 } : { x: 0.15, y: 0.1, w: 0.7, h: 0.8 } } },
      ];
    }),
  );
  doc = (await view(request, id)).doc;
  const tl = computeTimeline(doc);
  const fps = doc.format.fps;

  const render = async (name: string) => {
    const { job, view: after } = await renderAndWait(request, id, "preview");
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    const exp = after.exports.find((e: { jobId: string }) => e.jobId === job.id) ?? after.exports.find((e: { kind: string }) => e.kind === "preview");
    return (await downloadAndProbe(page, exp.downloadUrl, `${name}.mp4`)).file;
  };
  const file = await render("shader-effects");
  for (const [i, e] of EFFECTS.entries()) {
    // Mid-scene, clear of the transitions at either end.
    const s0 = (tl.scenes[i]!.start + (tl.scenes[i]!.overlapIn ?? 0)) / fps;
    const a = frameAt(file, s0 + 0.35, `shader-${e.id}-a.png`);
    const b = frameAt(file, s0 + 1.5, `shader-${e.id}-b.png`);
    expect(spread(a), `${e.id} draws something`).toBeGreaterThan(20);
    expect(diff(a, b), `${e.id} moves`).toBeGreaterThan(1.5);
  }

  // Repeatable: a second render of the same revision gives the same frames.
  await ops(request, id, [{ op: "setTitle", title: "Shader effects (again)" }]);
  const again = await render("shader-effects-again");
  for (const [i, e] of EFFECTS.entries()) {
    const t = (tl.scenes[i]!.start + (tl.scenes[i]!.overlapIn ?? 0)) / fps + 1;
    expect(diff(frameAt(file, t, `shader-${e.id}-r1.png`), frameAt(again, t, `shader-${e.id}-r2.png`)), `${e.id} repeats`).toBeLessThan(1);
  }
});
