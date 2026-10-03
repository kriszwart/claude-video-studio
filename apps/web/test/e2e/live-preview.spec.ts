import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ART, createProject } from "./helpers";

/** Live preview: the compiled composition plays in the editor under the HyperFrames runtime. */
test.describe.serial("live preview", () => {
  let id = "";
  test("plays, scrubs, and updates in place after an edit", async ({ page, request }) => {
    const created = await createProject(request, { templateId: "motion-reel", title: "Live preview", inputs: { hook: "Plan less. Ship more.", headline: "Tidewave plans your week", brandName: "Tidewave" } });
    id = created.project.id;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/projects/${id}`);
    const play = page.getByRole("button", { name: "Play" });
    await expect(play).toBeEnabled({ timeout: 60_000 });
    const scrub = page.getByRole("slider", { name: "Scrub" });

    // Plays in real time: the clock matches the wall time between Play and Pause (measured, since
    // clicking Pause can take a moment while the page draws shader effects).
    const t0 = Date.now();
    await play.click();
    await page.waitForTimeout(2000);
    await page.getByRole("button", { name: "Pause" }).click();
    const elapsed = (Date.now() - t0) / 1000;
    const t1 = Number(await scrub.inputValue());
    expect(t1).toBeGreaterThan(Math.max(1.2, elapsed - 1));
    expect(t1).toBeLessThan(elapsed + 0.5);

    // Scrub to scene 3 and read the frame from inside the player.
    await scrub.fill("12");
    const frame = page.frameLocator('iframe[title="Live preview"]');
    await expect(frame.locator("#root")).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(ART, "live-scene3.png") });

    // Edit the hook text: a new revision builds in the background and swaps in at the same time.
    const v = await (await request.get(`/api/projects/${id}`)).json();
    const scene = v.doc.scenes[0];
    const layer = scene.layers.find((l: { kind: string; slot?: string }) => l.kind === "text" && l.slot === "headline");
    const oldKey = await page.locator('iframe[title="Live preview"]').getAttribute("src");
    await page.reload();
    await expect(page.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 60_000 });
    await scrub.fill("1.5");
    const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: [{ op: "updateLayerText", sceneId: scene.id, layerId: layer.id, text: "Ship it on Friday" }] } });
    expect(r.status()).toBe(200);
    await page.reload();
    await expect(page.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 60_000 });
    await expect(page.locator('iframe[title="Live preview"]')).not.toHaveAttribute("src", oldKey!);
    await scrub.fill("1.5");
    await expect(page.frameLocator('iframe[title="Live preview"]').getByText("Ship it on Friday")).toBeVisible();
    await page.screenshot({ path: join(ART, "live-edited.png") });

    // In place, no reload: type in the inspector; the player swaps to the new revision at the same time.
    await scrub.fill("2");
    const before = await page.locator('iframe[title="Live preview"]').getAttribute("src");
    const field = page.getByRole("textbox", { name: "headline text" }).first();
    await field.fill("Ship it on Monday");
    await field.press("Tab");
    await expect(page.locator('iframe[title="Live preview"]')).not.toHaveAttribute("src", before!, { timeout: 60_000 });
    await expect(page.frameLocator('iframe[title="Live preview"]').getByText("Ship it on Monday")).toBeVisible();
    expect(Number(await scrub.inputValue())).toBeCloseTo(2, 0);
    await expect(page.locator('iframe[title="Live preview (updating)"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("bundle files are guarded: bad keys, traversal and other projects get 404", async ({ request }) => {
    const v = await (await request.get(`/api/projects/${id}`)).json();
    const live = await (await request.post(`/api/projects/${id}/live`, { data: { revisionId: v.revision.id } })).json();
    let key = live.job.result?.key as string | undefined;
    for (let i = 0; !key && i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      key = (await (await request.get(`/api/jobs/${live.job.id}`)).json()).job.result?.key;
    }
    expect(key).toMatch(/^[0-9a-f]{24}$/);
    const ok = await request.get(`/api/projects/${id}/live/${key}/index.html`);
    expect(ok.status()).toBe(200);
    expect(ok.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(ok.headers()["x-frame-options"]).toBe("SAMEORIGIN");
    expect(await ok.text()).toContain("vendor/hf-runtime.js");
    const audio = await request.get(`/api/projects/${id}/live/${key}/audio/mix.wav`, { headers: { range: "bytes=0-99" } });
    expect(audio.status()).toBe(206);
    expect(audio.headers()["content-range"]).toMatch(/^bytes 0-99\//);
    expect((await request.get(`/api/projects/${id}/live/${key}/..%2F..%2Flive.json`)).status()).toBe(404);
    expect((await request.get(`/api/projects/${id}/live/not-a-key/index.html`)).status()).toBe(404);
    const other = await createProject(request, { templateId: "motion-reel", title: "Other", inputs: { hook: "x", headline: "y", brandName: "z" } });
    expect((await request.get(`/api/projects/${other.project.id}/live/${key}/index.html`)).status()).toBe(404);
    // Every other page still refuses framing.
    expect((await request.get(`/projects/${id}`)).headers()["x-frame-options"]).toBe("DENY");
  });
});
