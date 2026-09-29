import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { apiUpload, ART, createProject, downloadAndProbe, FIX, renderAndWait } from "./helpers";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
type Job = { id: string; type: string; status: string; stage: string; result: Record<string, unknown> | null; createdAt: string };

async function ops(request: APIRequestContext, id: string, list: unknown[]) {
  const v = await (await request.get(`/api/projects/${id}`)).json();
  const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: list } });
  expect(r.status(), await r.text()).toBe(200);
  return r.json();
}
async function waitJob(request: APIRequestContext, id: string, timeoutMs = 20 * 60_000): Promise<Job> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await request.get(`/api/jobs/${id}`);
    const j = r.ok() ? (await r.json().catch(() => null))?.job : null;
    if (j && ["succeeded", "failed", "canceled"].includes(j.status)) return j;
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`job ${id} timed out`);
}
async function keyframes(request: APIRequestContext, id: string) {
  const r = await (await request.post(`/api/projects/${id}/keyframes`, { data: {} })).json();
  return waitJob(request, r.job.id);
}
function psnr(a: string, b: string, w: number, h: number): number {
  const out = execFileSync("sh", ["-c", `ffmpeg -hide_banner -i '${a}' -i '${b}' -lavfi "[0]scale=${w}:${h}[x];[1]scale=${w}:${h}[y];[x][y]psnr" -f null - 2>&1 | grep -o 'average:[0-9.inf]*' | tail -1`]).toString();
  const v = out.split(":")[1]?.trim() ?? "0";
  return v === "inf" ? 99 : Number(v);
}

test.describe.serial("M7: Redraw + Skia in the shared pipeline", () => {
  test("A28 + A30: mixed HTML/media/Skia/Redraw composition; preview/export agree; caches invalidate per scene", async ({ page, request }) => {
    test.setTimeout(60 * 60_000);
    const bottle = await apiUpload(request, join(FIX, "product-bottle-teal.png"), "image/png");
    const broll = await apiUpload(request, join(FIX, "broll-dashboard-pan.mp4"), "video/mp4");
    const music = await apiUpload(request, join(FIX, "music-launch-bed.m4a"), "audio/mp4");
    const p = await createProject(request, { templateId: "motion-reel", title: "M7 mixed graphics", inputs: { hook: "Mixed", headline: "Graphics", brandName: "Tidewave", music } });
    const id = p.project.id;
    const text = (sid: string, n: string, slot: string, role: string, t: string, backing = "none") => ({ id: `${sid}-${n}`, kind: "text", slot, role, text: t, hidden: false, style: { scale: 1, backing }, animation: { in: "rise", delayFrames: 6, stagger: false } });
    const g = (sid: string, n: string, backend: string, component: string, params: Record<string, unknown>, box: object) => ({ id: `${sid}-${n}`, kind: "graphics", slot: "decor", backend, component, componentVersion: 1, params, seed: 7, hidden: false, box });
    const scenes = [
      {
        id: "scn_m7media0001", purpose: "B-roll with Skia annotation", recipeSlot: "hook", durationFrames: 90, layout: "fullbleed-media", background: { type: "color", color: "#0b1020" }, transitionIn: { type: "cut", durationFrames: 0 }, motionIntensity: 0.6,
        layers: [
          { id: "scn_m7media0001-v", kind: "video", slot: "media", assetId: broll, sourceInSec: 0, sourceOutSec: null, muted: true, fit: "cover", focal: { x: 0.5, y: 0.5 }, frame: "none", hidden: false, animation: { in: "fade", delayFrames: 0, punchIn: 1 } },
          g("scn_m7media0001", "anno", "skia", "type-overlay", { text: "Live dashboard", color: "#ffffff", accent: "#f59e0b", size: 72, revealSec: 0.6 }, { x: 0.05, y: 0.08, w: 0.6, h: 0.22 }),
          text("scn_m7media0001", "t", "headline", "headline", "Everything at a glance", "translucent"),
        ],
      },
      {
        id: "scn_m7prod0002", purpose: "Skia mask reveal + Redraw backing", recipeSlot: "reveal", durationFrames: 90, layout: "hero-split", background: { type: "color", color: "#f4f1ea" }, transitionIn: { type: "fade", durationFrames: 8 }, motionIntensity: 0.6,
        layers: [
          g("scn_m7prod0002", "mask", "skia", "mask-reveal", { image: bottle, focalX: 0.5, focalY: 0.35, zoom: 2.2, revealSec: 1.4, corner: 28 }, { x: 0.52, y: 0.08, w: 0.44, h: 0.84 }),
          g("scn_m7prod0002", "glow", "redraw", "glow-backing", { color: "#111827", glowColor: "#8b8fff", feather: 32 }, { x: 0.01, y: 0.26, w: 0.48, h: 0.38 }),
          text("scn_m7prod0002", "t", "headline", "headline", "Tidewave Bottle"),
        ],
      },
    ];
    await ops(request, id, [
      { op: "replaceScenes", scenes },
    ]);

    // A30: first keyframes render both scenes; a repeat reuses both; a Skia parameter edit re-renders only its scene.
    const k1 = await keyframes(request, id);
    expect(k1.status, JSON.stringify(k1)).toBe("succeeded");
    expect(k1.result).toMatchObject({ rendered: 2, reused: 0 });
    const k2 = await keyframes(request, id);
    expect(k2.result).toMatchObject({ rendered: 0, reused: 2 });
    await ops(request, id, [{ op: "setGraphicsParams", sceneId: "scn_m7media0001", layerId: "scn_m7media0001-anno", params: { text: "Live dashboard, updated", color: "#ffffff", accent: "#34d399", size: 72, revealSec: 0.6 } }]);
    const k3 = await keyframes(request, id);
    expect(k3.result).toMatchObject({ rendered: 1, reused: 1 });
    const kf3 = (k3.result!.keyframes as { sceneId: string; cached: boolean; assetId: string; timeSec: number }[]);
    expect(kf3.find((k) => k.sceneId === "scn_m7media0001")!.cached).toBe(false);
    expect(kf3.find((k) => k.sceneId === "scn_m7prod0002")!.cached).toBe(true);
    // Template reuse: a project created from this one as a template reuses frames for identical scenes.
    const tpl = await request.post(`/api/projects/${id}/template`, { data: { name: `M7 mixed ${Date.now()}`, textVariables: [], includeAssetIds: [bottle, broll, music] } });
    expect(tpl.status(), await tpl.text()).toBeLessThan(300);
    const tplBody = await tpl.json();
    const reuse = await createProject(request, { templateId: tplBody.templateId, title: "M7 from template", inputs: {} });
    const k4 = await keyframes(request, reuse.project.id);
    writeFileSync(join(ART, "m7-cache.json"), JSON.stringify({ first: k1.result, repeat: k2.result, afterParamEdit: k3.result, fromTemplate: k4.result }, (k, v) => (k === "report" ? undefined : v), 2));
    expect(k4.result).toMatchObject({ rendered: 0, reused: 2 });

    // Captions for the mixed export (project content; not part of the template above).
    await ops(request, id, [
      { op: "setCaptions", captions: { enabled: true } },
      { op: "setCaptionCues", cues: [
        { id: "cue_m7_a", text: "Your whole week, at a glance.", anchor: { type: "scene", sceneId: "scn_m7media0001", offsetFrames: 0 }, startFrame: 12, endFrame: 80, timing: "manual" },
        { id: "cue_m7_b", text: "Designed to go everywhere.", anchor: { type: "scene", sceneId: "scn_m7prod0002", offsetFrames: 0 }, startFrame: 20, endFrame: 85, timing: "manual" },
      ] },
    ]);

    // Captions are part of each scene's look: both keyframes are re-rendered (cache key includes them).
    const k5 = await keyframes(request, id);
    expect(k5.result).toMatchObject({ rendered: 2, reused: 0 });
    const kf5 = k5.result!.keyframes as { sceneId: string; cached: boolean; assetId: string; timeSec: number }[];

    // A28: export the mixed composition; compare editor keyframes with export frames at the same times.
    const { job, view } = await renderAndWait(request, id, "exports");
    expect(job.status, JSON.stringify(job)).toBe("succeeded");
    const exp = view.exports.find((e: { jobId: string }) => e.jobId === job.id);
    const { file, probe } = await downloadAndProbe(page, exp.downloadUrl, "m7-mixed.mp4");
    expect(probe.streams.map((s: { codec_name: string }) => s.codec_name)).toEqual(["h264", "aac"]);
    expect(exp.checks.filter((c: { severity: string; ok: boolean }) => c.severity === "hard").every((c: { ok: boolean }) => c.ok)).toBe(true);
    const comparisons: { sceneId: string; timeSec: number; psnrDb: number }[] = [];
    for (const k of kf5) {
      const asset = (await (await request.get(`/api/assets/${k.assetId}`)).json()).asset;
      const kfFile = join(ART, `m7-keyframe-${k.sceneId}.jpg`);
      writeFileSync(kfFile, await (await request.get(asset.url)).body());
      const exFrame = join(ART, `m7-export-${k.sceneId}.png`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", k.timeSec.toFixed(3), "-i", file, "-frames:v", "1", exFrame]);
      comparisons.push({ sceneId: k.sceneId, timeSec: k.timeSec, psnrDb: Math.round(psnr(kfFile, exFrame, 672, 378) * 10) / 10 });
    }
    writeFileSync(join(ART, "m7-preview-vs-export.json"), JSON.stringify({ comparisons, loudness: exp.loudness }, null, 2));
    for (const c of comparisons) expect(c.psnrDb, JSON.stringify(c)).toBeGreaterThan(24);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-lavfi", "showspectrumpic=s=960x240:legend=0", join(ART, "m7-mixed-spectrum.png")]);
  });

  test("A29: capability routing — a Redraw job waits for a compatible worker; nothing blank is published", async ({ request }) => {
    test.setTimeout(40 * 60_000);
    const p = await createProject(request, { templateId: "motion-reel", title: "M7 routing (Redraw)", inputs: { hook: "Route", headline: "Me", brandName: "Tidewave" } });
    const v = await (await request.get(`/api/projects/${p.project.id}`)).json();
    const first = v.doc.scenes[0];
    await ops(request, p.project.id, [
      { op: "replaceScenes", scenes: [{ ...first, durationFrames: 45, layers: [...first.layers, { id: `${first.id}-rib`, kind: "graphics", slot: "decor", backend: "redraw", component: "ribbon", componentVersion: 1, params: { path: "wave", colors: "#3FCEBC,#5F96E7,#DE589F,#FAEC54", width: 60, drawSec: 1, glow: 24 }, seed: 3, hidden: false, box: { x: 0, y: 0.55, w: 1, h: 0.4 } }] }] },
    ]);
    const before = (await (await request.get(`/api/projects/${p.project.id}`)).json()).revision.id;
    const skiaOnly = await createProject(request, { templateId: "motion-reel", title: "M7 routing (Skia only)", inputs: { hook: "Skia", headline: "Only", brandName: "Tidewave" } });
    const sv = await (await request.get(`/api/projects/${skiaOnly.project.id}`)).json();
    const s0 = sv.doc.scenes[0];
    await ops(request, skiaOnly.project.id, [{ op: "replaceScenes", scenes: [{ ...s0, durationFrames: 45, layers: [...s0.layers, { id: `${s0.id}-anno`, kind: "graphics", slot: "decor", backend: "skia", component: "type-overlay", componentVersion: 1, params: { text: "Skia", size: 64 }, seed: 1, hidden: false, box: { x: 0.05, y: 0.7, w: 0.5, h: 0.2 } }] }] }]);

    // Swap the capable worker for one without Redraw.
    execFileSync(join(ROOT, "scripts", "dev-worker.sh"), ["stop"], { cwd: ROOT });
    const env = { ...process.env, REDRAW_DISABLED: "1" };
    for (const line of execFileSync("sh", ["-c", `set -a; . ${join(ROOT, ".env")}; env`]).toString().split("\n")) {
      const i = line.indexOf("=");
      if (i > 0 && !(line.slice(0, i) in env)) (env as Record<string, string>)[line.slice(0, i)] = line.slice(i + 1);
    }
    const log = openSync(join(ROOT, "data", "worker-noredraw.log"), "a");
    let limited: ChildProcess | null = spawn("node", ["--import", "tsx", "apps/worker/src/index.ts"], { cwd: ROOT, env, stdio: ["ignore", log, log] });
    try {
      await new Promise((r) => setTimeout(r, 12_000));
      const r = await (await request.post(`/api/projects/${p.project.id}/preview`, { data: {} })).json();
      expect(r.routing).toMatchObject({ requires: ["redraw"], blocked: true });
      expect(r.routing.reason).toMatch(/No online worker can render Redraw/);
      const s = await (await request.post(`/api/projects/${skiaOnly.project.id}/preview`, { data: {} })).json();
      expect(s.routing).toMatchObject({ requires: ["skia"], blocked: false });
      const sj = await waitJob(request, s.job.id);
      expect(sj.status).toBe("succeeded"); // Skia work proceeds on the limited worker
      const waiting = (await (await request.get(`/api/jobs/${r.job.id}`)).json()).job;
      expect(waiting.status).toBe("queued"); // not failed, not published blank
      expect(waiting.stage).toMatch(/waiting for a compatible worker/);
      const pv = await (await request.get(`/api/projects/${p.project.id}`)).json();
      expect(pv.revision.id).toBe(before);
      expect(pv.exports.length).toBe(0);
      // A capable worker comes online: the same job runs and produces a real export.
      limited.kill("SIGTERM");
      limited = null;
      execFileSync(join(ROOT, "scripts", "dev-worker.sh"), ["start"], { cwd: ROOT });
      const done = await waitJob(request, r.job.id, 30 * 60_000);
      expect(done.status, JSON.stringify(done)).toBe("succeeded");
      writeFileSync(join(ART, "m7-routing.json"), JSON.stringify({ redrawJob: { routing: r.routing, stageWhileWaiting: waiting.stage, final: done.status }, skiaJob: { routing: s.routing, final: sj.status } }, null, 2));
    } finally {
      limited?.kill("SIGTERM");
      execFileSync("sh", ["-c", `pgrep -f "apps/worker/src/index.ts" >/dev/null || ${join(ROOT, "scripts", "dev-worker.sh")} start`], { cwd: ROOT });
    }
  });
});
