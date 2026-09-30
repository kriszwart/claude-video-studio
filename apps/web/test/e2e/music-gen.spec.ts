import { expect, test, type APIRequestContext } from "@playwright/test";
import { createProject } from "./helpers";

/**
 * Phase 4 ElevenLabs music against the TEST-ONLY stand-in (scripts/fake-omnivoice.ts, /el/v1/music).
 * Covers the budget gate end to end: refused without a budget, one authorised unknown-price
 * request, known owner-entered price settled in the ledger, and release on a provider error.
 */
const STUB = "http://127.0.0.1:3902";
const job = async (request: APIRequestContext, id: string) => {
  for (let i = 0; i < 240; i++) {
    const j = (await (await request.get(`/api/jobs/${id}`)).json()).job;
    if (["succeeded", "failed", "canceled"].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("job did not finish");
};
const compose = async (request: APIRequestContext, id: string, data: Record<string, unknown>) => job(request, (await (await request.post(`/api/projects/${id}/music`, { data })).json()).job.id);
const ledger = async (request: APIRequestContext, id: string) => ((await (await request.get(`/api/projects/${id}/shots`)).json()).ledger as { capability: string; status: string; actualMicros: number | null }[]).filter((l) => l.capability === "music-generation");

test.describe.serial("ElevenLabs music", () => {
  test.beforeAll(async ({ request }) => {
    const up = await request.get(`${STUB}/el/v1/voices`, { headers: { "xi-api-key": "el-test-key" } }).catch(() => null);
    test.skip(!up || !up.ok(), "Start the stand-in: npx tsx scripts/fake-omnivoice.ts (and set ELEVENLABS_BASE_URL)");
  });
  test.afterAll(async ({ request }) => {
    await request.patch("/api/settings/providers", { data: { provider: "elevenlabs", settings: {} } });
    await request.put("/api/settings/providers", { data: { provider: "elevenlabs", secret: null } });
  });

  test("budget-gated composition lands on the timeline; prices settle; errors release", async ({ page, request }) => {
    test.setTimeout(300_000);
    await request.put("/api/settings/providers", { data: { provider: "elevenlabs", secret: "el-test-key" } });
    await request.patch("/api/settings/providers", { data: { provider: "elevenlabs", settings: {} } });
    const created = await createProject(request, { templateId: "motion-reel", title: "Music gen", inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave" } });
    const id = created.project.id;
    const before = ((await (await request.get(`${STUB}/__requests`)).json()) as unknown[]).length;

    // No budget: refused before anything is sent.
    const refused = await compose(request, id, { prompt: "calm synth bed", durationSec: 12 });
    expect(refused).toMatchObject({ status: "failed", error: { code: "unknown_price_unauthorized" } });
    expect(((await (await request.get(`${STUB}/__requests`)).json()) as unknown[]).length).toBe(before);

    // One authorised unknown-price request, used from the Audio tab.
    await request.put(`/api/projects/${id}/budget`, { data: { projectCeilingMicros: 5_000_000, operationCeilingMicros: 1_000_000, unknownPriceRequestsAuthorized: 1 } });
    await page.goto(`/projects/${id}`);
    await page.getByRole("tab", { name: "audio" }).click();
    await page.getByRole("spinbutton", { name: "Music length (seconds)" }).fill("12");
    await page.getByRole("button", { name: "Compose music" }).click();
    await expect(page.getByTestId("music-result")).toContainText("Added 12.0s", { timeout: 60_000 });
    const sent = ((await (await request.get(`${STUB}/__requests`)).json()) as Record<string, unknown>[]).filter((r) => r.elevenlabsMusic).at(-1)!;
    expect(sent).toMatchObject({ music_length_ms: 12000, force_instrumental: true, query: "?output_format=mp3_44100_128" });
    let v = await (await request.get(`/api/projects/${id}`)).json();
    const music = v.doc.audio.filter((t: { kind: string }) => t.kind === "music");
    expect(music).toHaveLength(1);
    expect((await ledger(request, id))[0]).toMatchObject({ status: "settled" });

    // The single unknown-price authorisation is used up.
    expect(await compose(request, id, { prompt: "calm synth bed", durationSec: 12 })).toMatchObject({ status: "failed", error: { code: "unknown_price_unauthorized" } });

    // With an owner-entered price the request is known, reserved and settled at the estimate; it replaces the bed.
    await page.goto("/settings");
    const card = page.getByRole("form", { name: "ElevenLabs music" });
    await card.getByRole("textbox", { name: "Music price per minute" }).fill("0.5");
    await card.getByRole("button", { name: "Save music settings" }).click();
    await expect.poll(async () => ((await (await request.get("/api/settings/providers")).json()).providers.find((p: { provider: string }) => p.provider === "elevenlabs").settings.musicPriceMicrosPerMinute)).toBe(500_000);
    const priced = await compose(request, id, { prompt: "brighter synth bed", durationSec: 12 });
    expect(priced).toMatchObject({ status: "succeeded", result: { priced: true } });
    expect((await ledger(request, id)).some((l) => l.status === "settled" && l.actualMicros === 100_000)).toBe(true);
    v = await (await request.get(`/api/projects/${id}`)).json();
    expect(v.doc.audio.filter((t: { kind: string }) => t.kind === "music")).toHaveLength(1);
    expect(v.doc.audio.find((t: { kind: string }) => t.kind === "music").assetId).toBe(priced.result.assetId);

    // A provider error releases the reservation and leaves the timeline alone.
    const quota = await compose(request, id, { prompt: "QUOTA please", durationSec: 12 });
    expect(quota).toMatchObject({ status: "failed", error: { code: "elevenlabs_quota" } });
    expect((await ledger(request, id)).filter((l) => l.status === "released")).toHaveLength(1);
    expect(quota.attempts).toBe(1);
  });
});
