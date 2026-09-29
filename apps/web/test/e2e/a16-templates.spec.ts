/**
 * A16: one real final export per core template family (T1–T7), plus the P6 preset, from
 * labelled sample fixtures. Each export is probed and fully decoded; frames at every scene
 * and a spectrogram are saved to artifacts/e2e/a16/ for the documented review.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { apiUpload, ART, createProject, FIX, waitForJobs } from "./helpers";

const OUT = join(ART, "a16");
mkdirSync(OUT, { recursive: true });
const summary: Record<string, unknown> = {};

async function ops(request: APIRequestContext, id: string, list: unknown[]) {
  const v = await (await request.get(`/api/projects/${id}`)).json();
  const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: list } });
  expect(r.status(), await r.text()).toBe(200);
  return r.json();
}

async function exportAndReview(page: Page, request: APIRequestContext, id: string, name: string) {
  const t0 = Date.now();
  expect((await request.post(`/api/projects/${id}/exports`, { data: {} })).status()).toBe(202);
  const r = await waitForJobs(request, id, "export", t0, 40 * 60_000);
  expect(r.job.status, `${name}: ${JSON.stringify(r.job.error)}`).toBe("succeeded");
  const exp = r.view.exports.find((e: { jobId: string }) => e.jobId === r.job.id);
  const res = await page.request.get(exp.downloadUrl);
  expect(res.status()).toBe(200);
  const file = join(OUT, `${name}.mp4`);
  writeFileSync(file, await res.body());
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]).toString());
  // Full decode: any decoding error fails the review.
  const decode = execFileSync("sh", ["-c", `ffmpeg -v error -i '${file}' -f null - 2>&1 | head -5`]).toString().trim();
  expect(decode, `${name} decodes cleanly`).toBe("");
  const scenes = r.view.doc.scenes as { purpose: string; durationFrames: number; transitionIn: { durationFrames: number; type: string } }[];
  const frames: string[] = [];
  let t = 0;
  scenes.forEach((s, i) => {
    const at = t + Math.min(2, (s.durationFrames / 30) * 0.55);
    const f = join(OUT, `${name}-${String(i + 1).padStart(2, "0")}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", "scale=480:-2", f]);
    frames.push(f);
    const next = scenes[i + 1];
    t += s.durationFrames / 30 - (next && next.transitionIn.type !== "cut" ? next.transitionIn.durationFrames / 30 : 0);
  });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-lavfi", "showspectrumpic=s=960x240:legend=0", join(OUT, `${name}-spectrum.png`)]);
  const silence = execFileSync("sh", ["-c", `ffmpeg -hide_banner -i '${file}' -af silencedetect=n=-50dB:d=1 -f null - 2>&1 | grep -c silence_start || true`]).toString().trim();
  const v = probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  summary[name] = { template: r.view.project.templateId, durationSec: Number(probe.format.duration), width: v.width, height: v.height, fps: v.r_frame_rate, codecs: probe.streams.map((s: { codec_name: string }) => s.codec_name), loudness: exp.loudness, checks: exp.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { name: string }) => c.name), warnings: exp.warnings, silentStretchesOver1s: Number(silence), scenes: scenes.map((s) => s.purpose), frames: frames.map((f) => f.split("/").pop()) };
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  expect(v.width).toBeGreaterThanOrEqual(1080);
  return { file, exp };
}

test.describe.serial("A16: every core template exports", () => {
  const up: Record<string, string> = {};
  test.beforeAll(async ({ request }) => {
    const files: [string, string, string][] = [
      ["logo", "logo-tidewave.png", "image/png"],
      ["dash", "tidewave-dashboard.png", "image/png"],
      ["insights", "tidewave-insights.png", "image/png"],
      ["mobile", "tidewave-mobile.png", "image/png"],
      ["bed", "music-launch-bed.m4a", "audio/mp4"],
      ["song", "music-song.m4a", "audio/mp4"],
      ["talk", "talking-head-avocado.mp4", "video/mp4"],
      ["srt", "talking-head-avocado.srt", "application/x-subrip"],
      ["night", "anime-night.mp4", "video/mp4"],
      ["city", "anime-city.mp4", "video/mp4"],
      ["run", "anime-run.mp4", "video/mp4"],
      ["clash", "anime-clash.mp4", "video/mp4"],
      ["sil", "anime-silhouette.mp4", "video/mp4"],
      ["teal", "product-bottle-teal.png", "image/png"],
      ["coral", "product-bottle-coral.png", "image/png"],
      ["navy", "product-bottle-night.png", "image/png"],
    ];
    for (const [k, f, m] of files) up[k] = await apiUpload(request, join(FIX, f), m);
  });

  test("T1 motion reel", async ({ page, request }) => {
    const p = await createProject(request, { templateId: "motion-reel", title: "A16 T1 motion reel", inputs: { hook: "Focus wins", headline: "Plan less. Ship more.", brandName: "Tidewave", points: ["Deep work", "Fewer meetings", "Clear weeks"], focal: "Your week, on your side", heroImage: up.dash, logo: up.logo, cta: "tidewave.example", music: up.bed }, durationSec: 20 });
    await exportAndReview(page, request, p.project.id, "t1-motion-reel");
  });

  test("T2 mascot story", async ({ page, request }) => {
    const p = await createProject(request, { templateId: "mascot-story", title: "A16 T2 mascot", inputs: { characterName: "Pip", species: "robot", color: "#22c55e", theme: "From garage to galaxy", eras: ["The garage", "The city", "The moon"], transformation: "Pip becomes a star pilot", finale: "Build yours", logo: up.logo, music: up.bed }, durationSec: 30 });
    await exportAndReview(page, request, p.project.id, "t2-mascot-story");
  });

  test("T3 product launch", async ({ page, request }) => {
    const p = await createProject(request, { templateId: "product-launch", title: "A16 T3 launch", inputs: { productName: "Tidewave", promise: "Plan your week in minutes, not hours.", problem: "Your calendar decides your week.", benefits: ["Auto-blocks focus time", "Moves meetings for you", "Weekly review in one screen"], screenshots: [up.dash, up.insights, up.mobile], logo: up.logo, cta: "Try it free", music: up.bed }, durationSec: 30 });
    await exportAndReview(page, request, p.project.id, "t3-product-launch");
  });

  test("T4 vertical short with narration", async ({ page, request }) => {
    const p = await createProject(request, { templateId: "vertical-short", title: "A16 T4 short", inputs: { hook: "Stop losing mornings to meetings.", points: ["Block two hours of deep work.", "Let the planner move meetings."], cta: "Try Tidewave free", brandName: "Tidewave", visuals: [up.dash, up.mobile], logo: up.logo, music: up.bed }, durationSec: 30 });
    const t0 = Date.now();
    expect((await request.post(`/api/projects/${p.project.id}/narration`, { data: { voiceId: "pico:en-US" } })).status()).toBe(202);
    expect((await waitForJobs(request, p.project.id, "tts", t0)).job.status).toBe("succeeded");
    await exportAndReview(page, request, p.project.id, "t4-vertical-short");
  });

  test("T5 talking head (cuts reviewed)", async ({ page, request }) => {
    const t0 = Date.now();
    const p = await createProject(request, { templateId: "talking-head", title: "A16 T5 talking head", inputs: { recording: up.talk, transcript: up.srt, topic: "Avocado toast" } });
    expect((await waitForJobs(request, p.project.id, "transcribe", t0)).job.status).toBe("succeeded");
    const t1 = Date.now();
    await request.post(`/api/projects/${p.project.id}/cuts`, { data: {} });
    const c = await waitForJobs(request, p.project.id, "propose_cuts", t1);
    await ops(request, p.project.id, [{ op: "acceptCuts", cutIds: c.view.doc.program.proposedCuts.map((x: { id: string }) => x.id) }]);
    await exportAndReview(page, request, p.project.id, "t5-talking-head");
  });

  test("T6 music video", async ({ page, request }) => {
    const t0 = Date.now();
    const p = await createProject(request, { templateId: "music-video", title: "A16 T6 music video", inputs: { song: up.song, excerptStart: 20, excerptEnd: 50, songTitle: "Night Drive", artist: "Sample Band", motif: "ring", lyrics: "Headlights on the open road\nCity fading into gold\nWe keep driving through the night" } });
    expect((await waitForJobs(request, p.project.id, "analyze_music", t0)).job.status).toBe("succeeded");
    await exportAndReview(page, request, p.project.id, "t6-music-video");
  });

  test("T7 anime opening (supplied footage, cut to the song)", async ({ page, request }) => {
    const t0 = Date.now();
    const p = await createProject(request, { templateId: "anime-opening", title: "A16 T7 anime", inputs: { song: up.song, excerptStart: 24, excerptEnd: 54, title: "Skyline Relay", synopsis: "Two couriers race across a floating city to deliver a stolen star map.", characters: ["Aki — courier in a red coat", "Ren — inventor"], footage: [up.night, up.run, up.sil, up.city, up.run, up.clash] } });
    const a = await waitForJobs(request, p.project.id, "analyze_music", t0);
    expect(a.job.status).toBe("succeeded");
    expect(a.view.doc.scenes.filter((s: { shot?: { status: string } }) => s.shot).every((s: { shot: { status: string } }) => s.shot.status === "accepted")).toBe(true);
    await exportAndReview(page, request, p.project.id, "t7-anime-opening");
  });

  test("P6 product spec ad (catalog photos only)", async ({ page, request }) => {
    const p = await createProject(request, { templateId: "product-spec-ad", title: "A16 P6 spec ad", inputs: { productName: "Tidewave Bottle", catalog: [up.teal, up.coral, up.navy], details: ["750 ml, fits every cup holder", "Keeps drinks cold for 24 hours", "Three colourways"], cta: "Shop the drop", logo: up.logo, music: up.bed, lifestyle: "no" }, durationSec: 18 });
    expect(p.doc.scenes.some((s: { purpose: string }) => /Lifestyle/.test(s.purpose))).toBe(false);
    await exportAndReview(page, request, p.project.id, "p6-product-spec-ad");
  });
});
