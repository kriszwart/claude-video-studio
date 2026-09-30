import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ART, createProject } from "./helpers";

test("timeline: click-to-seek, ruler scrub, trim by keyboard and drag, zoom", async ({ page, request }) => {
  const created = await createProject(request, { templateId: "motion-reel", title: "Timeline", inputs: { hook: "Plan less. Ship more.", headline: "Tidewave plans your week", brandName: "Tidewave" } });
  const id = created.project.id;
  await page.goto(`/projects/${id}`);
  await expect(page.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 60_000 });
  const tl = page.getByRole("region", { name: "Timeline" });
  const scrub = page.getByRole("slider", { name: "Scrub" });
  const view = async () => (await request.get(`/api/projects/${id}`)).json();

  // Clicking a scene selects it and moves the playhead to its start.
  const v0 = await view();
  const fps = v0.doc.format.fps;
  const starts: number[] = [];
  let acc = 0;
  for (const s of v0.doc.scenes) {
    const overlap = starts.length ? (s.transitionIn.type === "cut" ? 0 : s.transitionIn.durationFrames) : 0;
    acc -= overlap;
    starts.push(acc / fps);
    acc += s.durationFrames;
  }
  await tl.getByRole("button", { name: /^Scene 3:/ }).click();
  await expect.poll(async () => Number(await scrub.inputValue())).toBeCloseTo(starts[2]! + 0.01, 0);
  await expect(page.getByRole("tab", { name: "scene" })).toHaveAttribute("aria-selected", "true");

  // Ruler click seeks.
  const ruler = tl.getByRole("slider", { name: "Timeline position" });
  const rb = (await ruler.boundingBox())!;
  await page.mouse.click(rb.x + rb.width * 0.9, rb.y + rb.height / 2);
  await expect.poll(async () => Number(await scrub.inputValue())).toBeGreaterThan(v0.doc.scenes.reduce((a: number, s: { durationFrames: number }) => a + s.durationFrames, 0) / fps * 0.6);

  // Keyboard trim: 5 × →  = +0.5 s on scene 1, committed as one edit.
  const d0 = v0.doc.scenes[0].durationFrames;
  const handle = tl.getByRole("slider", { name: "Length of scene 1" });
  await handle.focus();
  for (let i = 0; i < 5; i++) await handle.press("ArrowRight");
  await expect.poll(async () => (await view()).doc.scenes[0].durationFrames, { timeout: 10_000 }).toBe(d0 + Math.round(0.1 * fps) * 5);

  // Drag trim: pull scene 2's end left.
  const v1 = await view();
  const d2 = v1.doc.scenes[1].durationFrames;
  await tl.getByRole("button", { name: /^Scene 2:/ }).hover();
  const h2 = tl.getByRole("slider", { name: "Length of scene 2" });
  const hb = (await h2.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 - 40, hb.y + hb.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await view()).doc.scenes[1].durationFrames, { timeout: 10_000 }).toBeLessThan(d2);
  await expect(page.getByTestId("save-state")).toHaveText("Saved");

  // Zoom in widens the track; Fit restores it.
  const box = tl.getByTestId("timeline");
  const w0 = await box.evaluate((el) => el.scrollWidth);
  await tl.getByRole("button", { name: "Zoom in" }).click();
  await tl.getByRole("button", { name: "Zoom in" }).click();
  expect(await box.evaluate((el) => el.scrollWidth)).toBeGreaterThan(w0 * 1.8);
  await tl.getByRole("button", { name: "Fit" }).click();
  expect(await box.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(w0 + 2);
  await page.screenshot({ path: join(ART, "timeline-e2e.png") });
});
