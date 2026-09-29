import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { apiUpload, createProject, downloadAndProbe, FIX, frameAt, renderAndWait, waitForJobs } from "./helpers";

test.describe.serial("M2 families", () => {
  let logo = "";
  let music = "";
  let shots: string[] = [];
  test.beforeAll(async ({ request }) => {
    logo = await apiUpload(request, join(FIX, "logo-tidewave.png"), "image/png");
    music = await apiUpload(request, join(FIX, "music-launch-bed.m4a"), "audio/mp4");
    shots = [await apiUpload(request, join(FIX, "tidewave-dashboard.png"), "image/png"), await apiUpload(request, join(FIX, "tidewave-insights.png"), "image/png"), await apiUpload(request, join(FIX, "tidewave-mobile.png"), "image/png")];
  });

  test("T4: narrated vertical short — narration fits, captions in safe area, audio present", async ({ page, request }) => {
    const created = await createProject(request, {
      templateId: "vertical-short",
      title: "E2E vertical short",
      inputs: {
        hook: "Stop losing your mornings to meetings.",
        points: ["Block two hours of deep work every day.", "Let the planner move meetings for you.", "Review where your week actually went."],
        cta: "Try Tidewave free today",
        brandName: "Tidewave",
        visuals: shots,
        logo,
        music,
      },
      durationSec: 35,
    });
    const id = created.project.id;
    await page.goto(`/projects/${id}`);
    await page.getByRole("tab", { name: "Audio" }).click();
    await expect(page.getByRole("button", { name: /Generate narration/ })).toBeEnabled();
    const t0 = Date.now();
    await page.getByRole("button", { name: /Generate narration/ }).click();
    const tts = await waitForJobs(request, id, "tts", t0);
    expect(tts.job.status, JSON.stringify(tts.job.error)).toBe("succeeded");
    const doc = tts.view.doc;
    const vo = doc.audio.filter((t: { kind: string }) => t.kind === "voiceover");
    expect(vo.length).toBe(doc.scenes.length);
    expect(doc.captions.enabled).toBe(true);
    expect(doc.captions.cues.length).toBeGreaterThan(doc.scenes.length);
    expect(doc.captions.cues.every((c: { timing: string }) => c.timing === "estimated")).toBe(true);
    expect(doc.format.safeArea).toBe("reels-shorts@2026-09");
    // Every narration fits its (possibly extended) scene.
    for (const r of tts.job.result.scenes as { sceneId: string; durationSec: number; warning?: string }[]) {
      const s = doc.scenes.find((x: { id: string }) => x.id === r.sceneId);
      expect(Math.ceil(r.durationSec * 30) + 6).toBeLessThanOrEqual(s.durationFrames);
      expect(r.warning).toBeUndefined();
    }
    // Re-running with unchanged scripts reuses every narration asset.
    const t1 = Date.now();
    await request.post(`/api/projects/${id}/narration`, { data: { voiceId: tts.job.result.voiceId } });
    const again = await waitForJobs(request, id, "tts", t1);
    expect((again.job.result.scenes as { reused: boolean }[]).every((s) => s.reused)).toBe(true);

    const r = await renderAndWait(request, id, "preview");
    expect(r.job.status, JSON.stringify(r.job.error)).toBe("succeeded");
    const exp = r.view.exports.find((e: { jobId: string }) => e.jobId === r.job.id);
    expect([exp.width, exp.height]).toEqual([540, 960]);
    const { file } = await downloadAndProbe(page, exp.downloadUrl, "t4-vertical.mp4");
    frameAt(file, 1.2, "t4-hook.png");
    frameAt(file, 9, "t4-point.png");
    frameAt(file, exp.durationSec - 1, "t4-cta.png");
    // Speech is audible: the mix is not silent for long stretches and loudness is near target.
    expect(exp.loudness.lufs).toBeGreaterThan(-20);
    const silence = execFileSync("sh", ["-c", `ffmpeg -hide_banner -i ${file} -af silencedetect=n=-45dB:d=1.2 -f null - 2>&1 | grep -c silence_start || true`]).toString().trim();
    expect(Number(silence)).toBe(0);
  });

  test("T1: motion graphics reel — five beats, brand substitution, music", async ({ page, request }) => {
    const created = await createProject(request, {
      templateId: "motion-reel",
      title: "E2E motion reel",
      inputs: { hook: "Focus wins", headline: "Plan less. Ship more. Every single week.", brandName: "Tidewave", points: ["Deep work", "Fewer meetings", "Clear weeks"], focal: "Your calendar, finally on your side", heroImage: shots[0], logo, cta: "tidewave.example", music },
      durationSec: 20,
    });
    expect(created.doc.scenes.length).toBeGreaterThanOrEqual(5);
    const r = await renderAndWait(request, created.project.id, "preview");
    expect(r.job.status, JSON.stringify(r.job.error)).toBe("succeeded");
    const exp = r.view.exports[0];
    const { file } = await downloadAndProbe(page, exp.downloadUrl, "t1-reel.mp4");
    const times = r.view.doc.scenes.map((_: unknown, i: number) => i);
    let t = 0;
    for (const [i, s] of r.view.doc.scenes.entries()) {
      frameAt(file, t + Math.min(2, s.durationFrames / 30 / 2), `t1-beat-${i + 1}.png`);
      t += s.durationFrames / 30 - (i + 1 < r.view.doc.scenes.length ? r.view.doc.scenes[i + 1].transitionIn.durationFrames / 30 : 0);
    }
    expect(times.length).toBeGreaterThanOrEqual(5);
    // Reuse with a much longer headline still fits (auto-fit, no overflow reported).
    const long = await createProject(request, { templateId: "motion-reel", title: "E2E reel long copy", inputs: { hook: "Focus", headline: "A considerably longer headline that has many more words than the original template copy expected", brandName: "Lumen Notes", logo, music }, durationSec: 15 });
    const t0 = Date.now();
    await request.post(`/api/projects/${long.project.id}/keyframes`, { data: {} });
    const kf = await waitForJobs(request, long.project.id, "keyframes", t0);
    expect(kf.job.result.report.overflow).toEqual([]);
  });

  test("P2: brand showreel with Redraw motif renders (or is explicitly blocked)", async ({ page, request }) => {
    test.setTimeout(45 * 60_000);
    const created = await createProject(request, {
      templateId: "brand-showreel",
      title: "E2E showreel",
      inputs: { channelName: "Tidewave", promise: "Deep work, protected by default.", thumbnails: shots, hero: shots[1], logo, cta: "Subscribe", music, milestone: ["Launched publicly in 2026"] },
      durationSec: 15,
    });
    const r = await renderAndWait(request, created.project.id, "preview");
    const caps = await (await request.get("/api/templates")).json();
    const showreel = caps.templates.find((t: { id: string }) => t.id === "brand-showreel");
    if (showreel.availability.missingOptional.includes("graphics-redraw")) {
      expect(r.job.status).toBe("failed");
      expect(r.job.error.code).toBe("graphics_unavailable");
      return;
    }
    expect(r.job.status, JSON.stringify(r.job.error)).toBe("succeeded");
    const exp = r.view.exports[0];
    const { file } = await downloadAndProbe(page, exp.downloadUrl, "p2-showreel.mp4");
    frameAt(file, 1.2, "p2-motif.png");
    frameAt(file, 4, "p2-wall.png");
    frameAt(file, 7.5, "p2-hero.png");
    frameAt(file, 10.5, "p2-promise.png");
    frameAt(file, 14, "p2-logo.png");
  });
});
