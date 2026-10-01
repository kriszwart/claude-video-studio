import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ART, createProject, waitForJobs } from "./helpers";

/**
 * ElevenLabs voices in the voice picker and narration, against the TEST-ONLY ElevenLabs stand-in
 * (scripts/fake-omnivoice.ts under /el, via ELEVENLABS_BASE_URL). The real API is unreachable here.
 */
const STUB = "http://127.0.0.1:3902";

test.describe.serial("ElevenLabs voices", () => {
  test.beforeAll(async ({ request }) => {
    const up = await request.get(`${STUB}/el/v1/voices`, { headers: { "xi-api-key": "el-test-key" } }).catch(() => null);
    test.skip(!up || !up.ok(), "Start the stand-in: npx tsx scripts/fake-omnivoice.ts (and set ELEVENLABS_BASE_URL)");
  });
  test.afterAll(async ({ request }) => {
    await request.put("/api/settings/providers", { data: { provider: "elevenlabs", secret: null } });
  });

  test("a rejected key is reported; with a valid key the account's voices (incl. clones) appear and narrate", async ({ page, request }) => {
    await request.put("/api/settings/providers", { data: { provider: "elevenlabs", secret: "wrong-key-123" } });
    const bad = await (await request.get("/api/voices")).json();
    expect(bad.elevenlabs).toMatchObject({ configured: true, reachable: false, message: "ElevenLabs rejected the API key." });

    // Settings UI: paste the key (never shown again).
    await page.goto("/settings");
    const card = page.locator("#provider-elevenlabs");
    await card.getByLabel(/ElevenLabs API key/).fill("el-test-key");
    await card.getByRole("button", { name: "Save key" }).click();
    await expect(card.getByRole("status")).toContainText("Saved");
    expect(await page.content()).not.toContain("el-test-key");

    const v = await (await request.get("/api/voices")).json();
    expect(v.elevenlabs).toMatchObject({ configured: true, reachable: true });
    const el = v.voices.filter((x: { kind: string }) => x.kind === "elevenlabs");
    expect(el.map((x: { label: string }) => x.label)).toEqual(["Kris (your clone) — ElevenLabs", "Quota Test — ElevenLabs", "Rachel — ElevenLabs"]);
    expect(JSON.stringify(v)).not.toContain("el-test-key");

    const created = await createProject(request, { templateId: "vertical-short", title: "ElevenLabs short", inputs: { hook: "Stop losing your mornings.", points: ["Block two hours of deep work."], cta: "Try it free", brandName: "Tidewave" }, durationSec: 20 });
    const id = created.project.id;
    await page.goto(`/projects/${id}`);
    await page.getByRole("tab", { name: "Audio" }).click();
    await page.getByLabel("Voice").selectOption("elevenlabs:21m00Tcm4TlvDq8ikWAM");
    await expect(page.getByText(/ElevenLabs bills your ElevenLabs account per character/)).toBeVisible();
    const t0 = Date.now();
    await page.getByRole("button", { name: /Generate narration/ }).click();
    const tts = await waitForJobs(request, id, "tts", t0);
    expect(tts.job.status, JSON.stringify(tts.job.error)).toBe("succeeded");
    expect(tts.job.result).toMatchObject({ provider: "elevenlabs", engine: "hosted" });
    const scripts = tts.view.doc.scenes.map((s: { script: { narration: string } }) => s.script.narration.trim()).filter(Boolean) as string[];
    expect(tts.job.result.charactersSynthesized).toBe(scripts.reduce((a, t) => a + t.length, 0));
    await expect(page.getByText(/characters sent to ElevenLabs in the last run/)).toBeVisible();
    await page.screenshot({ path: join(ART, "elevenlabs-audio-panel.png") });
    const vo = tts.view.doc.audio.filter((t: { kind: string }) => t.kind === "voiceover");
    expect(vo.length).toBe(scripts.length);

    // Unchanged scripts are reused: nothing is sent (or billed) again.
    const t1 = Date.now();
    await request.post(`/api/projects/${id}/narration`, { data: { voiceId: "elevenlabs:21m00Tcm4TlvDq8ikWAM" } });
    const again = await waitForJobs(request, id, "tts", t1);
    expect(again.job.result.charactersSynthesized).toBe(0);
  });

  test("an exhausted ElevenLabs quota fails clearly, without retrying or changing the project", async ({ request }) => {
    const created = await createProject(request, { templateId: "vertical-short", title: "ElevenLabs quota", inputs: { hook: "Hello there.", points: ["One point."], cta: "Go", brandName: "Tidewave" }, durationSec: 15 });
    const id = created.project.id;
    const before = (await (await request.get(`/api/projects/${id}`)).json()).revision.id;
    const t0 = Date.now();
    await request.post(`/api/projects/${id}/narration`, { data: { voiceId: "elevenlabs:quotaVoice01" } });
    const r = await waitForJobs(request, id, "tts", t0);
    expect(r.job.status).toBe("failed");
    expect(r.job.attempts).toBe(1);
    expect(r.job.error).toMatchObject({ code: "elevenlabs_quota", recovery: expect.stringContaining("OmniVoice or built-in voice") });
    expect(r.view.revision.id).toBe(before);
  });
});
