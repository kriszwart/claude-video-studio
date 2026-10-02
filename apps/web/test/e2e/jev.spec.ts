import { expect, test } from "@playwright/test";

/**
 * Jev live suggestions in the composer, against the TEST-ONLY Jev stand-in in scripts/fake-fal.ts
 * (JEV_BASE_URL). The stand-in answers from keywords, so the expected picks are deterministic.
 */
const STUB = "http://127.0.0.1:3910";

test.describe.serial("Jev suggestions", () => {
  test.beforeAll(async ({ request }) => {
    const up = await request.get(`${STUB}/__jev`).catch(() => null);
    test.skip(!up || !up.ok(), "Start the stand-in: npx tsx scripts/fake-fal.ts (and set JEV_BASE_URL)");
  });
  test.afterAll(async ({ request }) => {
    await request.put("/api/settings/providers", { data: { provider: "jev", secret: null } });
  });

  test("no key: the composer asks once and shows nothing", async ({ page, request }) => {
    await request.put("/api/settings/providers", { data: { provider: "jev", secret: null } });
    expect(await (await request.post("/api/compose/suggest", { data: { prompt: "A vertical TikTok launch video for our app" } })).json()).toEqual({ available: false });
    await page.goto("/projects/new");
    await page.getByLabel("Describe the video").fill("A vertical TikTok launch video for our app, 15 second, energetic");
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("jev-suggestions")).toHaveCount(0);
  });

  test("with a key: suggestions follow what's typed, and a click applies them", async ({ page, request }) => {
    await request.put("/api/settings/providers", { data: { provider: "jev", secret: "jev-test-key" } });
    // Settings: the live check goes through the same client.
    const check = await (await request.post("/api/settings/providers", { data: { provider: "jev" } })).json();
    expect(check.check).toMatchObject({ ok: true });

    await page.goto("/projects/new");
    const box = page.getByLabel("Describe the video");
    await box.fill("A vertical TikTok launch video for our app, 15 second, energetic, with a voiceover");
    const row = page.getByTestId("jev-suggestions");
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.locator('[data-suggest="template"]')).toHaveText("+ Product Launch");
    await expect(row.locator('[data-suggest="aspect"]')).toHaveText("+ 9:16");
    await expect(row.locator('[data-suggest="length"]')).toContainText("15");
    await expect(row.locator('[data-suggest="style"]')).toHaveText("+ Energetic");

    // One chip applies just that setting.
    await row.locator('[data-suggest="aspect"]').click();
    await expect(page.getByRole("button", { name: /^9:16 · Auto length/ })).toBeVisible();
    // "Use all" applies the rest, including the template.
    await row.getByRole("button", { name: "Use all" }).click();
    await expect(page.getByRole("button", { name: "Remove template Product Launch" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^9:16 · 15/ })).toBeVisible();
    await expect(page.getByTestId("jev-suggestions")).toHaveCount(0); // everything suggested is now set

    // What was sent: the typed request, never keys or the whole project.
    const sent = (await (await request.get(`${STUB}/__jev`)).json()) as { state: { request: string } }[];
    expect(sent.at(-1)!.state.request).toContain("vertical TikTok launch");
  });

  test("templates built from your own recording are suggested before footage is attached, marked as needing it", async ({ request }) => {
    await request.put("/api/settings/providers", { data: { provider: "jev", secret: "jev-test-key" } });
    const ask = async (video: number) => (await (await request.post("/api/compose/suggest", { data: { prompt: "A short course lesson that teaches focus time", attachments: { video } } })).json()).suggestion.templateId;
    expect(await ask(0)).toMatchObject({ value: "course-lesson", needsRecording: true });
    const withFootage = await ask(1);
    expect(withFootage.value).toBe("course-lesson");
    expect(withFootage.needsRecording).toBeUndefined();
  });

  test("a slow answer is dropped without blocking anything", async ({ request }) => {
    await request.put("/api/settings/providers", { data: { provider: "jev", secret: "jev-test-key" } });
    const t0 = Date.now();
    const r = await (await request.post("/api/compose/suggest", { data: { prompt: "SLOW: a launch video for our app" } })).json();
    expect(Date.now() - t0).toBeLessThan(4500);
    expect(r).toMatchObject({ available: true, suggestion: {} });
    expect(r.error).toContain("in time");
  });
});
