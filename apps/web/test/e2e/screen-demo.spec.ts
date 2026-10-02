import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { computeTimeline, soundEvents, type ProjectDocument } from "@vs/domain";
import { apiUpload, createProject, downloadAndProbe, FIX, frameAt, renderAndWait } from "./helpers";

/**
 * Screen demo: a cursor works the real screenshot while the camera zooms. Steps are added by
 * clicking the screenshot in the Scene tab, or planned by Claude (the Agent SDK TEST DOUBLE).
 */
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const STATE = process.env.STUDIO_CLAUDE_SDK_DOUBLE_STATE ?? join(ROOT, "data", "fake-claude.json");
async function scenario(request: APIRequestContext, s: "signed_out" | "max") {
  writeFileSync(STATE, JSON.stringify({ scenario: s }));
  expect((await request.post("/api/settings/claude")).status()).toBe(200);
}
const view = async (request: APIRequestContext, id: string) => (await request.get(`/api/projects/${id}`)).json();
/** Mean absolute difference between two frames (small greyscale), 0–255. */
function diff(a: string, b: string) {
  const g = (f: string) => execFileSync("ffmpeg", ["-v", "error", "-i", f, "-vf", "scale=64:36,format=gray", "-f", "rawvideo", "-"]);
  const x = g(a), y = g(b);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += Math.abs(x[i]! - y[i]!);
  return s / x.length;
}

test.describe.serial("Screen demo", () => {
  test.afterAll(async ({ request }) => scenario(request, "signed_out"));

  test("steps from clicks on the screenshot, then from Claude; the render follows the cursor with the camera", async ({ page, request }) => {
    test.setTimeout(15 * 60_000);
    const shot = await apiUpload(request, join(FIX, "tidewave-dashboard.png"), "image/png");
    const { project } = await createProject(request, { templateId: "product-launch", title: "Screen demo", inputs: { productName: "Tidewave", promise: "Plan less, ship more", problem: "Too many tabs", benefits: ["Plans your week"], cta: "Try it free", screenshots: [shot] } });
    const id = project.id;
    let doc = (await view(request, id)).doc as ProjectDocument;
    const idx = doc.scenes.findIndex((s) => s.recipeSlot === "demo");
    expect(idx).toBeGreaterThan(0);
    const demoScene = doc.scenes[idx]!;
    expect(demoScene.demo).toMatchObject({ steps: [] });

    // By hand: two clicks on the screenshot add two steps, spaced through the scene.
    await page.goto(`/projects/${id}`);
    await page.getByRole("navigation", { name: "Scenes" }).locator("li").nth(idx).getByRole("button").first().click();
    await page.getByRole("tab", { name: "scene" }).click();
    const editor = page.getByTestId("demo-editor");
    const screen = editor.getByTestId("demo-screen");
    await expect(screen.locator("img")).toBeVisible();
    const box = (await screen.boundingBox())!;
    await screen.click({ position: { x: box.width * 0.2, y: box.height * 0.25 } });
    await expect(editor.getByTestId("demo-steps").locator("li")).toHaveCount(1);
    await screen.click({ position: { x: box.width * 0.75, y: box.height * 0.6 } });
    await expect(editor.getByTestId("demo-steps").locator("li")).toHaveCount(2);
    doc = (await view(request, id)).doc;
    let steps = doc.scenes[idx]!.demo!.steps;
    expect(steps[0]!.x).toBeCloseTo(0.2, 1);
    expect(steps[1]!.y).toBeCloseTo(0.6, 1);
    expect(steps[0]!.atFrames).toBeLessThan(steps[1]!.atFrames);
    await editor.getByLabel("Step 1 label").fill("Plan week");
    await editor.getByLabel("Step 1 label").press("Tab");
    await expect.poll(async () => (await view(request, id)).doc.scenes[idx].demo.steps[0].label).toBe("Plan week");

    // Claude plans it from the screen (test double: a click, then pointing at a result).
    await scenario(request, "max");
    await editor.getByRole("button", { name: "Re-plan with Claude" }).click();
    await expect.poll(async () => (await view(request, id)).doc.scenes[idx].demo.steps.map((s: { label: string }) => s.label), { timeout: 120_000 }).toEqual(["TEST DOUBLE button", "TEST DOUBLE result"]);
    doc = (await view(request, id)).doc;
    steps = doc.scenes[idx]!.demo!.steps;
    expect(steps.map((s) => [s.action, s.zoom])).toEqual([["click", 2], ["move", 2.5]]);
    // The click is a sound-effect moment, on the press.
    const tl = computeTimeline(doc);
    expect(soundEvents(doc, "minimal").filter((e) => e.role === "click").map((e) => e.frame)).toEqual([tl.scenes[idx]!.start + steps[0]!.atFrames + 1]);

    // Rendered: the camera has zoomed in at each step, and pulled back by the end of the scene.
    const { view: after } = await renderAndWait(request, id, "preview");
    const exp = after.exports.find((e: { kind: string }) => e.kind === "preview");
    const { file } = await downloadAndProbe(page, exp.downloadUrl, "screen-demo.mp4");
    const fps = doc.format.fps;
    const s0 = tl.scenes[idx]!.start / fps;
    const at = (name: string, t: number) => frameAt(file, t, `screen-demo-${name}.png`);
    const wide = at("wide", s0 + 1.0);
    const step1 = at("step1", s0 + steps[0]!.atFrames / fps + 0.2);
    const step2 = at("step2", s0 + steps[1]!.atFrames / fps + 0.1);
    const next = doc.scenes[idx + 1]!;
    const end = at("end", s0 + (doc.scenes[idx]!.durationFrames - (next.transitionIn.type === "cut" ? 0 : next.transitionIn.durationFrames)) / fps - 0.1);
    expect(diff(wide, step1)).toBeGreaterThan(6); // zoomed in: a very different picture
    expect(diff(step1, step2)).toBeGreaterThan(5); // moved to the second target
    expect(diff(wide, end)).toBeLessThan(3); // pulled back to the wide view, headline back
  });

  test("the camera moves without one-frame glitches (frame scan in Review & repair)", async ({ request }) => {
    test.setTimeout(10 * 60_000);
    const list = (await (await request.get("/api/projects")).json()).projects as { id: string; title: string }[];
    const id = list.find((p) => p.title === "Screen demo")!.id;
    const v = await view(request, id);
    const job = (await (await request.post(`/api/projects/${id}/quality`, { data: { revisionId: v.revision.id, maxRepairPasses: 0 } })).json()).job;
    await expect.poll(async () => (await (await request.get(`/api/jobs/${job.id}`)).json()).job.status, { timeout: 8 * 60_000, intervals: [2000] }).toBe("succeeded");
    const r = (await (await request.get(`/api/projects/${id}/quality`)).json()).reports[0];
    const demoScene = v.doc.scenes.find((s: { recipeSlot: string }) => s.recipeSlot === "demo").id;
    expect((r.report.unresolved as { code: string; sceneId?: string }[]).filter((i) => /^frame_/.test(i.code) && i.sceneId === demoScene)).toEqual([]);
  });
});
