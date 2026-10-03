import { expect, test } from "@playwright/test";
import { createProject } from "./helpers";

/**
 * Send to Lanternist, against the TEST-ONLY Lanternist MCP stand-in in scripts/fake-fal.ts
 * (POST /lantern/mcp, token "lantern-test-key") and its S3 stand-in for picture hosting (:3911).
 * Not tested against the real Lanternist or a real bucket.
 */
const STUB = "http://127.0.0.1:3910";
const MCP = `${STUB}/lantern/mcp`;
const S3 = "http://127.0.0.1:3911";
const SHARE = { endpoint: S3, bucket: "fluxtify-share", region: "auto", accessKeyId: "share-test-access", publicBaseUrl: "", linkDays: 7 };

test.describe.serial("Send to Lanternist", () => {
  test.beforeAll(async ({ request }) => {
    const up = await request.get(`${STUB}/__lantern`).catch(() => null);
    test.skip(!up || !up.ok(), "Start the stand-in: npx tsx scripts/fake-fal.ts");
  });
  test.afterAll(async ({ request }) => {
    await request.put("/api/settings/providers", { data: { provider: "lanternist", secret: null } });
    await request.patch("/api/settings/providers", { data: { provider: "lanternist", settings: {} } });
    await request.put("/api/settings/providers", { data: { provider: "share", secret: null } });
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
    await panel.getByRole("radio", { name: /Lanternist draws them/ }).check();
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
      // Lanternist takes shot lengths in tenths of a second.
      t += Math.round((doc.scenes[i]!.durationFrames / fps) * 10) / 10;
      expect(s.description).toContain(doc.scenes[i]!.purpose);
      expect(s.generated_image).toBeTruthy();
    }
  });

  test("picture hosting: the live check uploads, opens and deletes a test file; a wrong key fails", async ({ request }) => {
    expect((await request.patch("/api/settings/providers", { data: { provider: "share", settings: { ...SHARE, accessKeyId: "nobody" } } })).ok()).toBe(true);
    await request.put("/api/settings/providers", { data: { provider: "share", secret: "share-test-secret" } });
    const bad = await (await request.post("/api/settings/providers", { data: { provider: "share" } })).json();
    expect(bad.check).toMatchObject({ ok: false });
    expect(bad.check.message).toMatch(/Upload failed/);

    await request.patch("/api/settings/providers", { data: { provider: "share", settings: SHARE } });
    const good = await (await request.post("/api/settings/providers", { data: { provider: "share" } })).json();
    expect(good.check).toMatchObject({ ok: true });
    expect(good.check.message).toMatch(/signed links, valid 7 days.*aren't https/);
    expect((await (await request.get(`${S3}/__s3`)).json()).keys).toEqual([]); // the test file is gone
    // The secret never comes back.
    expect(JSON.stringify(good.providers)).not.toContain("share-test-secret");
    const bucket = await (await request.patch("/api/settings/providers", { data: { provider: "share", settings: { ...SHARE, bucket: "Not A Bucket" } } })).json();
    expect(bucket.error?.message ?? JSON.stringify(bucket)).toMatch(/lowercase/);
  });

  test("Fluxtify's own frames are captured, uploaded under unguessable names and attached to each shot", async ({ page, request }) => {
    test.setTimeout(240_000);
    await request.put("/api/settings/providers", { data: { provider: "lanternist", secret: "lantern-test-key" } });
    await request.patch("/api/settings/providers", { data: { provider: "lanternist", settings: { mcpUrl: MCP } } });
    await request.put("/api/settings/providers", { data: { provider: "share", secret: "share-test-secret" } });
    await request.patch("/api/settings/providers", { data: { provider: "share", settings: SHARE } });

    const title = `Lanternist frames ${Date.now()}`;
    const { project, doc } = await createProject(request, { templateId: "motion-reel", title, inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave" } });
    await page.goto(`/projects/${project.id}`);
    await page.getByRole("tab", { name: "export" }).click();
    const panel = page.getByTestId("lanternist");
    await panel.getByRole("radio", { name: /This project's frames/ }).check();
    await panel.getByRole("button", { name: "Send to Lanternist" }).click();
    const result = panel.getByTestId("lanternist-result");
    await expect(result).toBeVisible({ timeout: 200_000 });
    await expect(result).toContainText(`${doc.scenes.length} pictures attached`);
    await expect(result).toContainText("Picture links work until");

    const film = (await (await request.get(`${STUB}/__lantern`)).json()).films.find((f: { title: string }) => f.title === `${title} (from Fluxtify)`);
    const keys: string[] = (await (await request.get(`${S3}/__s3`)).json()).keys;
    for (const s of film.shots) {
      const u = new URL(s.generated_image);
      expect(u.origin).toBe(S3);
      expect(u.pathname).toMatch(/^\/fluxtify-share\/fluxtify-shared\/[0-9a-f]{36}\.jpg$/);
      expect(u.pathname).not.toContain(project.id);
      expect(u.searchParams.get("X-Amz-Expires")).toBe(String(7 * 86400));
      expect(keys).toContain(u.pathname);
      // The link opens a JPEG; without the signature the bucket refuses.
      const r = await request.get(s.generated_image);
      expect(r.headers()["content-type"]).toBe("image/jpeg");
      expect((await r.body()).subarray(0, 2).toString("hex")).toBe("ffd8");
      expect((await request.get(`${S3}${u.pathname}`)).status()).toBe(403);
    }
    expect(film.shots).toHaveLength(doc.scenes.length);
  });

  test("without picture hosting the frames option is off and the API refuses it in the job", async ({ page, request }) => {
    await request.put("/api/settings/providers", { data: { provider: "share", secret: null } });
    const { project } = await createProject(request, { templateId: "motion-reel", title: "Lanternist no hosting", inputs: { hook: "Hi", headline: "Plan less", brandName: "Tidewave" } });
    await page.goto(`/projects/${project.id}`);
    await page.getByRole("tab", { name: "export" }).click();
    const panel = page.getByTestId("lanternist");
    await expect(panel.getByRole("radio", { name: /This project's frames/ })).toBeDisabled();
    await expect(panel.getByRole("link", { name: "Settings → Picture hosting" })).toBeVisible();
    const before = (await (await request.get(`${STUB}/__lantern`)).json()).films.length;
    const job = (await (await request.post(`/api/projects/${project.id}/lanternist`, { data: { pictures: "fluxtify" } })).json()).job;
    await expect.poll(async () => (await (await request.get(`/api/jobs/${job.id}`)).json()).job.status, { timeout: 60_000 }).toBe("failed");
    expect((await (await request.get(`/api/jobs/${job.id}`)).json()).job.error.code).toBe("share_not_configured");
    expect((await (await request.get(`${STUB}/__lantern`)).json()).films.length).toBe(before); // no film was created
  });
});
