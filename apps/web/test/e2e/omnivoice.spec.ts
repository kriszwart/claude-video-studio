import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ART, createProject, waitForJobs } from "./helpers";

/**
 * OmniVoice narration against the TEST-ONLY stand-in server (scripts/fake-omnivoice.ts, an
 * OpenAI-compatible speech API producing a tone). A real OmniVoice server is not available here.
 */
const OV = "http://127.0.0.1:3902";

test.describe.serial("OmniVoice voices", () => {
  test.beforeAll(async ({ request }) => {
    const up = await request.get(`${OV}/v1/audio/voices`).catch(() => null);
    test.skip(!up || !up.ok(), "Start the stand-in: npx tsx scripts/fake-omnivoice.ts");
  });
  test.afterAll(async ({ request }) => {
    await request.patch("/api/settings/providers", { data: { provider: "omnivoice", settings: { baseUrl: "", voices: [] } } });
  });

  test("set up in Settings, voices listed, narration synthesised by OmniVoice with the designed voice", async ({ page, request }) => {
    // Settings UI: address + one designed voice.
    await page.goto("/settings");
    const card = page.locator("li", { hasText: "OmniVoice (local voice server)" });
    await card.getByLabel("Server address").fill(`${OV}/`);
    await card.getByRole("button", { name: "Add voice" }).click();
    await card.getByLabel("Voice name on the server").fill("studio_designed");
    await card.getByLabel("Display label").fill("Calm designed voice");
    await card.getByLabel("Voice description").fill("calm, warm, mid-pitch narrator");
    await card.getByRole("button", { name: "Save OmniVoice settings" }).click();
    await expect(card.getByRole("status")).toContainText("Saved");
    await card.getByRole("button", { name: "Test connection" }).click();
    await expect(card.getByRole("status")).toContainText("Connected to OmniVoice at http://127.0.0.1:3902; 3 voice(s) available.");

    const v = await (await request.get("/api/voices")).json();
    expect(v.omnivoice).toMatchObject({ configured: true, reachable: true });
    const ids = v.voices.filter((x: { kind: string }) => x.kind === "omnivoice").map((x: { id: string }) => x.id);
    expect(ids).toEqual(["omnivoice:studio_designed", "omnivoice:narrator_warm", "omnivoice:my_clone"]);

    const created = await createProject(request, { templateId: "vertical-short", title: "OmniVoice short", inputs: { hook: "Stop losing your mornings.", points: ["Block two hours of deep work.", "Let the planner move meetings."], cta: "Try it free", brandName: "Tidewave" }, durationSec: 25 });
    const id = created.project.id;
    await page.goto(`/projects/${id}`);
    await page.getByRole("tab", { name: "Audio" }).click();
    await page.getByLabel("Voice").selectOption("omnivoice:studio_designed");
    await page.screenshot({ path: join(ART, "omnivoice-audio-panel.png") });
    const t0 = Date.now();
    await page.getByRole("button", { name: /Generate narration/ }).click();
    const tts = await waitForJobs(request, id, "tts", t0);
    expect(tts.job.status, JSON.stringify(tts.job.error)).toBe("succeeded");
    expect(tts.job.result).toMatchObject({ provider: "omnivoice", engine: "local", voiceId: "omnivoice:studio_designed" });
    const vo = tts.view.doc.audio.filter((t: { kind: string }) => t.kind === "voiceover");
    expect(vo.length).toBe(tts.view.doc.scenes.filter((s: { script: { narration: string } }) => s.script.narration.trim()).length);
    const reqs = (await (await request.get(`${OV}/__requests`)).json()) as { voice: string; instructions?: string; response_format: string }[];
    const mine = reqs.filter((r) => r.voice === "studio_designed");
    expect(mine.length).toBe(vo.length);
    expect(mine.every((r) => r.instructions === "calm, warm, mid-pitch narrator" && r.response_format === "wav")).toBe(true);

    // Unchanged scripts are reused; editing the voice description re-synthesises.
    const t1 = Date.now();
    await request.post(`/api/projects/${id}/narration`, { data: { voiceId: "omnivoice:studio_designed" } });
    const again = await waitForJobs(request, id, "tts", t1);
    expect((again.job.result.scenes as { reused: boolean }[]).every((s) => s.reused)).toBe(true);
    await request.patch("/api/settings/providers", { data: { provider: "omnivoice", settings: { baseUrl: OV, voices: [{ name: "studio_designed", instructions: "bright, fast, energetic" }] } } });
    const t2 = Date.now();
    await request.post(`/api/projects/${id}/narration`, { data: { voiceId: "omnivoice:studio_designed" } });
    const redo = await waitForJobs(request, id, "tts", t2);
    expect((redo.job.result.scenes as { reused: boolean }[]).some((s) => s.reused)).toBe(false);
    writeFileSync(join(ART, "omnivoice-report.json"), JSON.stringify({ first: tts.job.result, redo: redo.job.result }, null, 2));
  });

  test("a stopped server or unknown voice gives a clear error; nothing half-applied", async ({ request }) => {
    const created = await createProject(request, { templateId: "vertical-short", title: "OmniVoice errors", inputs: { hook: "Hello there.", points: ["One point."], cta: "Go", brandName: "Tidewave" }, durationSec: 15 });
    const id = created.project.id;
    const before = (await (await request.get(`/api/projects/${id}`)).json()).revision.id;
    await request.patch("/api/settings/providers", { data: { provider: "omnivoice", settings: { baseUrl: OV, voices: [] } } });
    const t0 = Date.now();
    await request.post(`/api/projects/${id}/narration`, { data: { voiceId: "omnivoice:not_on_server" } });
    const bad = await waitForJobs(request, id, "tts", t0);
    expect(bad.job.status).toBe("failed");
    expect(bad.job.error).toMatchObject({ code: "omnivoice_unknown_voice" });
    expect(bad.job.error.message).toContain("not_on_server");
    expect(bad.view.revision.id).toBe(before);

    await request.patch("/api/settings/providers", { data: { provider: "omnivoice", settings: { baseUrl: "http://127.0.0.1:3999", voices: [{ name: "narrator_warm" }] } } });
    const v = await (await request.get("/api/voices")).json();
    expect(v.omnivoice.configured).toBe(true);
    const t1 = Date.now();
    await request.post(`/api/projects/${id}/narration`, { data: { voiceId: "omnivoice:narrator_warm" } });
    // Retryable: it is retried with backoff, then fails with the "start the server" guidance.
    for (let i = 0; i < 90; i++) {
      const view = await (await request.get(`/api/projects/${id}`)).json();
      const j = view.jobs.find((x: { type: string; createdAt: string }) => x.type === "tts" && new Date(x.createdAt).getTime() >= t1 - 2000);
      if (j?.error?.code) {
        expect(j.error.code).toBe("omnivoice_unreachable");
        expect(j.error.recovery).toMatch(/Start the OmniVoice server/);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("no error reported");
  });
});
