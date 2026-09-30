import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiUpload, createProject, downloadAndProbe, FIX, waitForJobs } from "./helpers";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

test.describe.serial("reliability (A06, A07)", () => {
  test("A06: missing credentials give action-specific setup errors; manual editing keeps working", async ({ request }) => {
    const providers = await (await request.get("/api/settings/providers")).json();
    const has = (p: string) => providers.providers.find((x: { provider: string }) => x.provider === p)?.configured;
    const claude = await (await request.get("/api/settings/claude")).json();
    test.skip(claude.readiness.available || has("elevenlabs"), "Claude or ElevenLabs is available on this server; A06 needs them absent.");
    const created = await createProject(request, { templateId: "motion-reel", title: "A06 creds", inputs: { hook: "Hi", headline: "Plan less", brandName: "Tidewave" } });
    const id = created.project.id;
    const rev = (await (await request.get(`/api/projects/${id}`)).json()).revision.id;
    const plan = await request.post(`/api/projects/${id}/plan`, { data: { baseRevisionId: rev } });
    expect(plan.status()).toBe(412);
    const pj = await plan.json();
    expect(pj.error.code).toBe("claude_unavailable");
    expect(pj.error.recovery).toMatch(/settings#claude/);
    const asst = await request.post(`/api/projects/${id}/assistant`, { data: { request: "make it blue", baseRevisionId: rev } });
    expect(asst.status()).toBe(412);
    // Hosted TTS without a key: the job fails with a setup error, nothing half-applied.
    const t0 = Date.now();
    expect((await request.post(`/api/projects/${id}/narration`, { data: { voiceId: "elevenlabs:any-voice" } })).status()).toBe(202);
    const tts = await waitForJobs(request, id, "tts", t0);
    expect(tts.job.status).toBe("failed");
    expect(tts.job.error.code).toBe("credentials_missing");
    expect(tts.job.error.recovery).toMatch(/ElevenLabs/);
    // Manual editing still works.
    const v = await (await request.get(`/api/projects/${id}`)).json();
    const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: [{ op: "setTitle", title: "A06 still editable" }] } });
    expect(r.status()).toBe(200);
  });

  test("A07: worker killed mid-export → lease expires, job retries, exactly one export is published", async ({ page, request }) => {
    test.setTimeout(20 * 60_000);
    const logo = await apiUpload(request, join(FIX, "logo-tidewave.png"), "image/png");
    const music = await apiUpload(request, join(FIX, "music-launch-bed.m4a"), "audio/mp4");
    const created = await createProject(request, { templateId: "motion-reel", title: "A07 crash", inputs: { hook: "Focus", headline: "Plan less. Ship more.", brandName: "Tidewave", points: ["Deep work", "Fewer meetings"], logo, music, cta: "tidewave.example" }, durationSec: 12 });
    const id = created.project.id;
    const t0 = Date.now();
    const start = await request.post(`/api/projects/${id}/exports`, { data: {} });
    expect(start.status()).toBe(202);
    const jobId: string = (await start.json()).job.id;
    // Wait until the export is actually rendering, then crash the worker (SIGKILL: no cleanup).
    for (let i = 0; i < 240; i++) {
      const j = (await (await request.get(`/api/jobs/${jobId}`)).json()).job;
      if (j.status === "running" && /render|encod|compil|mix/.test(j.stage)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const pid = readFileSync(join(ROOT, "data", "worker.pid"), "utf8").trim();
    execFileSync("kill", ["-9", pid]);
    const crashed = (await (await request.get(`/api/jobs/${jobId}`)).json()).job;
    expect(crashed.status).toBe("running"); // lease still held by the dead worker
    execFileSync(join(ROOT, "scripts", "dev-worker.sh"), ["start"]);
    const done = await waitForJobs(request, id, "export", t0, 15 * 60_000);
    expect(done.job.id).toBe(jobId);
    expect(done.job.status, JSON.stringify(done.job.error)).toBe("succeeded");
    expect(done.job.attempts).toBeGreaterThanOrEqual(2);
    const exports = done.view.exports.filter((e: { jobId: string }) => e.jobId === jobId);
    expect(exports).toHaveLength(1);
    const { probe } = await downloadAndProbe(page, exports[0].downloadUrl, "a07-recovered.mp4");
    expect(probe.streams.map((s: { codec_type: string }) => s.codec_type).sort()).toEqual(["audio", "video"]);
    expect(Number(probe.format.duration)).toBeGreaterThan(11);
    // Retrying the finished job doesn't publish a second export.
    const again = await request.post(`/api/jobs/${jobId}/retry`);
    expect([200, 202, 409]).toContain(again.status());
    const after = await (await request.get(`/api/projects/${id}`)).json();
    expect(after.exports.filter((e: { jobId: string }) => e.jobId === jobId)).toHaveLength(1);
  });
});
