import { expect, test } from "@playwright/test";
import { createProject } from "./helpers";

/**
 * Send to Lanternist, against the TEST-ONLY Lanternist MCP stand-in in scripts/fake-fal.ts
 * (POST /lantern/mcp, token "lantern-test-key"). Not tested against the real Lanternist.
 */
const STUB = "http://127.0.0.1:3910";
const MCP = `${STUB}/lantern/mcp`;

test.describe.serial("Send to Lanternist", () => {
  test.beforeAll(async ({ request }) => {
    const up = await request.get(`${STUB}/__lantern`).catch(() => null);
    test.skip(!up || !up.ok(), "Start the stand-in: npx tsx scripts/fake-fal.ts");
  });
  test.afterAll(async ({ request }) => {
    await request.put("/api/settings/providers", { data: { provider: "lanternist", secret: null } });
    await request.patch("/api/settings/providers", { data: { provider: "lanternist", settings: {} } });
  });

  test("without a token the panel points to Settings; a wrong token fails the check", async ({ page, request }) => {
    await request.put("/api/settings/providers", { data: { provider: "lanternist", secret: null } });
    const { project } = await createProject(request, { templateId: "motion-reel", title: "Lanternist none", inputs: { hook: "Hi", headline: "Plan less", brandName: "Tidewave" } });
    await page.goto(`/projects/${project.id}`);
    await page.getByRole("tab", { name: "export" }).click();
    await expect(page.getByTestId("lanternist").getByRole("link", { name: "Settings → Lanternist" })).toBeVisible();

    expect((await request.patch("/api/settings/providers", { data: { provider: "lanternist", settings: { mcpUrl: MCP } } })).ok()).toBe(true);
    await request.put("/api/settings/providers", { data: { provider: "lanternist", secret: "wrong" } });
    const bad = await (await request.post("/api/settings/providers", { data: { provider: "lanternist" } })).json();
    expect(bad.check).toMatchObject({ ok: false });
  });

  test("sends one shot per scene with timings, draws pictures and makes a review link", async ({ page, request }) => {
    test.setTimeout(120_000);
    await request.put("/api/settings/providers", { data: { provider: "lanternist", secret: "lantern-test-key" } });
    await request.patch("/api/settings/providers", { data: { provider: "lanternist", settings: { mcpUrl: MCP } } });
    expect((await (await request.post("/api/settings/providers", { data: { provider: "lanternist" } })).json()).check).toMatchObject({ ok: true });

    const title = `Lanternist ${Date.now()}`;
    const { project, doc } = await createProject(request, { templateId: "motion-reel", title, inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave" } });
    await page.goto(`/projects/${project.id}`);
    await page.getByRole("tab", { name: "export" }).click();
    const panel = page.getByTestId("lanternist");
    await panel.getByRole("checkbox", { name: /Draw a picture for each shot/ }).click();
    await panel.getByRole("button", { name: "Send to Lanternist" }).click();
    const result = panel.getByTestId("lanternist-result");
    await expect(result).toBeVisible({ timeout: 90_000 });
    await expect(result).toContainText(`Sent ${doc.scenes.length} shots, ${doc.scenes.length} pictures drawn`);

    const state = await (await request.get(`${STUB}/__lantern`)).json();
    const film = state.films.find((f: { title: string }) => f.title === `${title} (from Fluxtify)`);
    expect(film).toBeTruthy();
    await expect(result.getByRole("link", { name: "Open in Lanternist" })).toHaveAttribute("href", `https://lanternist.example/editor?project=${film.id}`);
    await expect(result.getByRole("link", { name: "Review link" })).toHaveAttribute("href", `https://lanternist.example/v/${film.id}`);
    expect(film.shots).toHaveLength(doc.scenes.length);
    const fps = (await (await request.get(`/api/projects/${project.id}`)).json()).doc.format.fps;
    let t = 0;
    for (const [i, s] of film.shots.entries()) {
      expect(s.start_time).toBeCloseTo(t, 1);
      t += doc.scenes[i]!.durationFrames / fps;
      expect(s.description).toContain(doc.scenes[i]!.purpose);
      expect(s.generated_image).toBeTruthy();
    }
  });
});
