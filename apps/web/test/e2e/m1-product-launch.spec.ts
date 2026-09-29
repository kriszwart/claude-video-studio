import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { downloadAndProbe, FIX, frameAt, uploadVia, waitForJobs } from "./helpers";

/**
 * M1 acceptance (A01–A05, A10) through the real UI, API, worker and renderer.
 * Claude is not used here: without an API key the deterministic template path is the
 * product's documented no-AI workflow. The live Claude checks are reported separately.
 */
test.describe.serial("M1 product launch", () => {
  let projectId = "";
  let firstExport: { videoUrl: string; revisionId: string } | null = null;

  test("A01: create from uploaded brand assets, render draft and final MP4", async ({ page }) => {
    await page.goto("/projects/new?template=product-launch");
    await expect(page.getByRole("heading", { name: "Product Launch" })).toBeVisible();
    await page.getByLabel("Project title").fill("E2E Tidewave launch");
    await page.locator("#in-productName").fill("Tidewave");
    await page.locator("#in-promise").fill("Plans your day around deep work, automatically.");
    await page.locator("#in-problem").fill("Your calendar decides your day. It shouldn't.");
    await page.locator("#in-benefits").fill("Protects two focus blocks every day\nMoves meetings without the back-and-forth\nWeekly insight into where time went");
    await page.locator("#in-cta").fill("Try Tidewave free");
    await page.locator("#in-destinationUrl").fill("tidewave.example");
    await uploadVia(page, page.getByTestId("field-screenshots"), [join(FIX, "tidewave-dashboard.png"), join(FIX, "tidewave-insights.png")]);
    await expect(page.getByTestId("field-screenshots").locator(".chip")).toHaveCount(2, { timeout: 60_000 });
    await uploadVia(page, page.getByTestId("field-logo"), [join(FIX, "logo-tidewave.svg")]);
    await expect(page.getByTestId("field-logo").locator(".chip")).toHaveCount(1, { timeout: 60_000 });
    await uploadVia(page, page.getByTestId("field-music"), [join(FIX, "music-launch-bed.m4a")]);
    await expect(page.getByTestId("field-music").locator(".chip")).toHaveCount(1, { timeout: 60_000 });
    await page.getByRole("button", { name: "Create from template (no AI)" }).click();
    await page.waitForURL(/\/projects\/prj_/);
    projectId = page.url().split("/").pop()!;
    await expect(page.getByTestId("save-state")).toHaveText("Saved");

    const t0 = Date.now();
    await page.getByRole("button", { name: /Render draft/ }).click();
    const { job } = await waitForJobs(page.request, projectId, "preview", t0);
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    await expect(page.locator("video")).toBeVisible();

    await page.getByRole("tab", { name: "Export" }).click();
    const t1 = Date.now();
    await page.getByRole("button", { name: /Export final MP4/ }).click();
    const fin = await waitForJobs(page.request, projectId, "export", t1);
    expect(fin.job.status, JSON.stringify(fin.job.error)).toBe("succeeded");
    const exp = fin.view.exports.find((e: { kind: string }) => e.kind === "final");
    firstExport = exp;
    expect(exp.checks.filter((c: { severity: string; ok: boolean }) => c.severity === "hard" && !c.ok)).toEqual([]);
    const { file, probe } = await downloadAndProbe(page, exp.downloadUrl, "a01-final.mp4");
    const v = probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    const a = probe.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
    expect(v.codec_name).toBe("h264");
    expect([v.width, v.height]).toEqual([1920, 1080]);
    expect(a.codec_name).toBe("aac");
    expect(Number(probe.format.duration)).toBeCloseTo(30, 1);
    // Keep representative frames for manual review (logo end card, benefits, hook).
    frameAt(file, 2.5, "a01-hook.png");
    frameAt(file, 15, "a01-benefits.png");
    frameAt(file, 28.5, "a01-endcard.png");
  });

  test("A03: reload restores scene order, assets, audio and status", async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    const before = await (await page.request.get(`/api/projects/${projectId}`)).json();
    await page.reload();
    await expect(page.getByTestId("save-state")).toHaveText("Saved");
    const after = await (await page.request.get(`/api/projects/${projectId}`)).json();
    expect(after.revision.id).toBe(before.revision.id);
    expect(after.doc.scenes.map((s: { id: string }) => s.id)).toEqual(before.doc.scenes.map((s: { id: string }) => s.id));
    expect(after.doc.audio).toEqual(before.doc.audio);
    await expect(page.getByRole("navigation", { name: "Scenes" }).locator("li")).toHaveCount(before.doc.scenes.length);
    await expect(page.locator("video")).toBeVisible();
  });

  test("A02: revise only scene three; other scenes unchanged; timing ripples", async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    const before = await (await page.request.get(`/api/projects/${projectId}`)).json();
    const nav = page.getByRole("navigation", { name: "Scenes" });
    await nav.locator("li").nth(2).getByRole("button").first().click();
    await expect(page.getByRole("heading", { name: /^Scene 3:/ })).toBeVisible();
    const dur = page.locator("#dur");
    const oldDur = Number(await dur.inputValue());
    await dur.fill(String(oldDur + 2));
    await dur.press("Enter");
    await expect(page.getByTestId("save-state")).toHaveText("Saved");
    const headline = page.getByLabel("headline text");
    await headline.fill("Why teams switch to Tidewave");
    await headline.blur();
    await expect(page.getByTestId("save-state")).toHaveText("Saved");
    await expect.poll(async () => (await (await page.request.get(`/api/projects/${projectId}`)).json()).revision.seq).toBeGreaterThanOrEqual(before.revision.seq + 2);
    const after = await (await page.request.get(`/api/projects/${projectId}`)).json();
    const stable = (x: unknown) => JSON.stringify(x);
    for (const i of [0, 1, 3]) expect(stable(after.doc.scenes[i])).toBe(stable(before.doc.scenes[i]));
    expect(after.doc.scenes[2].durationFrames).toBe(before.doc.scenes[2].durationFrames + 60);
    const hl = after.doc.scenes[2].layers.find((l: { role?: string }) => l.role === "headline");
    expect(hl.text).toBe("Why teams switch to Tidewave");
    // Ripple: the music is absolute (fixed); scene 4 moves 2 s later.
    expect(after.doc.audio[0].anchor).toEqual(before.doc.audio[0].anchor);
    // Undo restores the previous state as a new revision.
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByTestId("save-state")).toHaveText("Saved");
    const undone = await (await page.request.get(`/api/projects/${projectId}`)).json();
    expect(undone.doc.scenes[2].layers.find((l: { role?: string }) => l.role === "headline").text).not.toBe("Why teams switch to Tidewave");
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(page.getByTestId("save-state")).toHaveText("Saved");
  });

  test("A10: edits during a running export do not change its inputs", async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    const before = await (await page.request.get(`/api/projects/${projectId}`)).json();
    await page.getByRole("tab", { name: "Export" }).click();
    const t0 = Date.now();
    await page.getByRole("button", { name: /Export final MP4/ }).click();
    // While it renders, edit scene 1's headline.
    await page.getByRole("tab", { name: "Scene" }).click();
    await page.getByRole("navigation", { name: "Scenes" }).locator("li").first().getByRole("button").first().click();
    const h = page.getByLabel("headline text");
    await h.fill("Edited while exporting");
    await h.blur();
    await expect(page.getByTestId("save-state")).toHaveText("Saved");
    const { job, view } = await waitForJobs(page.request, projectId, "export", t0);
    expect(job.status).toBe("succeeded");
    expect(job.revisionId).toBe(before.revision.id);
    expect(view.revision.id).not.toBe(before.revision.id);
    const exp = view.exports.find((e: { jobId: string }) => e.jobId === job.id);
    expect(exp.revisionId).toBe(before.revision.id);
    const { file } = await downloadAndProbe(page, exp.downloadUrl, "a10-pinned.mp4");
    frameAt(file, 3, "a10-hook-pinned.png");
    // A stale write is rejected with 409 rather than overwriting newer edits.
    const stale = await page.request.post(`/api/projects/${projectId}/operations`, { data: { baseRevisionId: before.revision.id, ops: [{ op: "setTitle", title: "stale write" }] } });
    expect(stale.status()).toBe(409);
    expect(firstExport).not.toBeNull();
  });

  test("A05: portrait version reflows layout with readable text and CTA", async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Project" }).click();
    await page.getByRole("radio", { name: "9:16" }).click();
    await expect(page.getByTestId("save-state")).toHaveText("Saved");
    const view = await (await page.request.get(`/api/projects/${projectId}`)).json();
    expect(view.doc.format.aspect).toBe("9:16");
    const t0 = Date.now();
    await page.getByRole("button", { name: /render draft/i }).click();
    const r = await waitForJobs(page.request, projectId, "preview", t0);
    expect(r.job.status).toBe("succeeded");
    const exp = r.view.exports.find((e: { jobId: string }) => e.jobId === r.job.id);
    expect([exp.width, exp.height]).toEqual([540, 960]);
    const { file } = await downloadAndProbe(page, exp.downloadUrl, "a05-portrait.mp4");
    frameAt(file, 4, "a05-portrait-hook.png");
    frameAt(file, exp.durationSec - 1.5, "a05-portrait-cta.png");
    // Compiled page reported no text overflow.
    const kf = await waitForJobs(page.request, projectId, "keyframes", t0);
    expect((kf.job.result as { report: { overflow: string[] } }).report.overflow).toEqual([]);
  });

  test("A04: save as template and create a second product without original media", async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    const orig = await (await page.request.get(`/api/projects/${projectId}`)).json();
    await page.getByRole("tab", { name: "Export" }).click();
    await page.getByRole("button", { name: /Save as reusable template/ }).click();
    const tplName = `Launch — calm dark ${Date.now()}`;
    await page.locator("#tplname").fill(tplName);
    await page.getByRole("button", { name: "Preview reuse" }).click();
    await expect(page.getByText(/Reuse preview/)).toBeVisible();
    await page.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByText(/Saved as template/)).toBeVisible();
    const tpls = await (await page.request.get("/api/templates")).json();
    const tpl = tpls.templates.find((t: { name: string }) => t.name === tplName);
    expect(tpl).toBeTruthy();

    await page.goto(`/projects/new?template=${tpl.id}`);
    await page.getByLabel("Project title").fill("Lumen Notes launch (from custom template)");
    const def = await (await page.request.get(`/api/templates/${tpl.id}`)).json();
    for (const f of def.definition.inputs as { id: string; kind: string; label: string; default?: unknown }[]) {
      if (f.kind === "text" || f.kind === "longtext") {
        const v = String(f.default ?? "")
          .replace(/Plans your day around deep work, automatically\./, "Links every note you take, automatically.")
          .replace(/Your calendar decides your day\. It shouldn't\./, "Your notes are scattered. Connect them.")
          .replace(/tidewave\.example/g, "lumen.example")
          .replace(/Tidewave/g, "Lumen Notes");
        await page.locator(`#in-${f.id}`).fill(v);
      }
    }
    const imgFields = def.definition.inputs.filter((f: { kind: string }) => f.kind === "image");
    for (const f of imgFields) {
      const src = f.id === "logo" ? "logo-lumen.png" : /Benefit/i.test(f.label) ? "lumen-graph.png" : "lumen-editor.png";
      await uploadVia(page, page.getByTestId(`field-${f.id}`), [join(FIX, src)]);
      await expect(page.getByTestId(`field-${f.id}`).locator(".chip")).toHaveCount(1, { timeout: 60_000 });
    }
    await page.getByRole("button", { name: "Create from template (no AI)" }).click();
    await page.waitForURL(/\/projects\/prj_/);
    const second = page.url().split("/").pop()!;
    const v2 = await (await page.request.get(`/api/projects/${second}`)).json();
    const used = new Set<string>();
    for (const s of v2.doc.scenes) for (const l of s.layers) if (l.assetId) used.add(l.assetId);
    for (const t of v2.doc.audio) used.add(t.assetId);
    const origAssets = new Set<string>();
    for (const s of orig.doc.scenes) for (const l of s.layers) if (l.assetId) origAssets.add(l.assetId);
    for (const t of orig.doc.audio) origAssets.add(t.assetId);
    expect([...used].filter((a) => origAssets.has(a))).toEqual([]);
    const t0 = Date.now();
    await page.getByRole("button", { name: /Render draft/ }).click();
    const r = await waitForJobs(page.request, second, "preview", t0);
    expect(r.job.status, JSON.stringify(r.job.error)).toBe("succeeded");
    const exp = r.view.exports[0];
    const { file } = await downloadAndProbe(page, exp.downloadUrl, "a04-second-product.mp4");
    frameAt(file, 2.5, "a04-second-hook.png");
    frameAt(file, 9, "a04-second-reveal.png");
    frameAt(file, exp.durationSec - 1, "a04-second-end.png");
  });
});
