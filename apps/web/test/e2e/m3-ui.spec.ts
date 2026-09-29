import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiUpload, createProject, FIX, waitForJobs } from "./helpers";

test("M3 UI: review cuts, place a phrase-timed beat by dragging, create a variant", async ({ page, request }) => {
  test.setTimeout(10 * 60_000);
  const recording = await apiUpload(request, join(FIX, "talking-head-avocado.mp4"), "video/mp4");
  const srt = await apiUpload(request, join(FIX, "talking-head-avocado.srt"), "application/x-subrip");
  const t0 = Date.now();
  const created = await createProject(request, { templateId: "talking-head", title: `UI talking head ${Date.now()}`, inputs: { recording, transcript: srt, topic: "Avocado toast" } });
  const id = created.project.id;
  expect((await waitForJobs(request, id, "transcribe", t0)).job.status).toBe("succeeded");

  await page.goto(`/projects/${id}`);
  await page.getByRole("tab", { name: "transcript" }).click();
  await expect(page.getByRole("list", { name: "Transcript segments" }).getByRole("listitem")).toHaveCount(9);

  // Propose cuts, then review: keep one pause, cut the retake.
  const t1 = Date.now();
  await page.getByRole("button", { name: /Find pauses, fillers & retakes/ }).click();
  expect((await waitForJobs(request, id, "propose_cuts", t1)).job.status).toBe("succeeded");
  const retake = page.getByTestId("cut-mistake");
  await expect(retake).toBeVisible({ timeout: 15_000 });
  await expect(retake).toContainText("avocado toast");
  await retake.getByRole("button", { name: "Cut" }).click();
  await expect(page.getByTestId("cut-mistake")).toHaveCount(0);
  await page.getByTestId("cut-silence").first().getByRole("button", { name: "Keep" }).click();
  await expect(page.getByText("cut", { exact: true }).first()).toBeVisible();

  // Beat: find the phrase, choose the occurrence, add it.
  await page.getByLabel("Cue phrase").fill("Tool B");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByText(/#1 at/)).toBeVisible();
  await page.getByRole("button", { name: "Add beat" }).click();
  const beat = page.locator('[data-testid^="beat-"]').last();
  await expect(beat).toContainText("mapped");
  // Missing phrase is reported, not guessed.
  await page.getByLabel("Cue phrase").fill("Tool Z");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByText(/is not in the transcript/)).toBeVisible();

  // Drag the anchor to the right third and verify it is saved and locked.
  const pad = beat.getByRole("application");
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.25, { steps: 5 });
  await page.mouse.up();
  await expect(beat).toContainText(/80%, 25% · locked/);
  const v = await (await request.get(`/api/projects/${id}`)).json();
  const saved = v.doc.beats.at(-1);
  expect(saved.anchorLocked).toBe(true);
  expect(saved.anchor.x).toBeCloseTo(0.8, 1);

  // Variant from the panel.
  await page.getByRole("button", { name: "+ Course lesson" }).click();
  await expect(page.getByText(/Created “.* — Course”/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("link", { name: /Course:/ })).toBeVisible();
  await page.screenshot({ path: join(import.meta.dirname, "..", "..", "..", "..", "artifacts", "e2e", "m3-ui-panel.png"), fullPage: false });
});
