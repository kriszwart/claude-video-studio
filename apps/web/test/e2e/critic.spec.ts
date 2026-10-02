import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";

/** Phase 3 visual critic against the Claude Agent SDK TEST DOUBLE (canned findings; real frames). */
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const STATE = process.env.STUDIO_CLAUDE_SDK_DOUBLE_STATE ?? join(ROOT, "data", "fake-claude.json");
async function scenario(request: APIRequestContext, s: "signed_out" | "max") {
  writeFileSync(STATE, JSON.stringify({ scenario: s }));
  expect((await request.post("/api/settings/claude")).status()).toBe(200);
}
const view = async (request: APIRequestContext, id: string) => (await request.get(`/api/projects/${id}`)).json();
const critiques = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/projects/${id}/critique`)).json()).critiques;
const lastPromptImages = () => {
  const lines = readFileSync(`${STATE}.log.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.event === "prompt");
  return lines.at(-1)?.images as number;
};

test.describe.serial("Visual critic", () => {
  test.afterAll(async ({ request }) => {
    await scenario(request, "signed_out");
  });

  test("reviews real frames, applies a selected note through the assistant, then compares", async ({ page, request }) => {
    test.setTimeout(240_000);
    await scenario(request, "max");
    const created = await (await request.post("/api/projects", { data: { templateId: "motion-reel", title: "Critic", inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave" } } })).json();
    const id = created.project.id as string;

    await page.goto(`/projects/${id}`);
    await page.getByRole("tab", { name: "critic" }).click();
    await page.getByRole("textbox", { name: "What should the critic focus on?" }).fill("Is the hook readable?");
    await page.getByRole("button", { name: "Review this version" }).click();
    await expect(page.getByTestId("critique")).toBeVisible({ timeout: 120_000 });

    const [c1] = await critiques(request, id);
    const frames = c1.report.frames.length;
    const scenes = (await view(request, id)).doc.scenes.length;
    // One settled frame per scene at least, rendered and actually sent to Claude as images.
    expect(frames).toBeGreaterThanOrEqual(scenes);
    expect(lastPromptImages()).toBe(frames);
    expect(c1.report.summary).toContain(`${frames} frame(s)`);
    expect(c1.report.focus).toBe("Is the hook readable?");
    expect(c1.report.findings[0]).toMatchObject({ scene: 1, severity: "fix", category: "readability" });
    expect(c1.report.frames.every((f: { url: string }) => f.url.includes("/api/files/"))).toBe(true);

    const findings = page.getByTestId("finding");
    await expect(findings).toHaveCount(2);
    await expect(findings.nth(0).getByRole("checkbox")).toBeChecked();
    await expect(findings.nth(1).getByText("Needs you")).toBeVisible();
    await expect(page.getByTestId("score-readability")).toContainText("2/5");
    // The critic's own short list: changes first, then what only watching or listening can settle.
    const still = page.getByTestId("still-change");
    await expect(still).toContainText("What I'd still change");
    await expect(still.locator("ol li")).toHaveText(["Scene 1: TEST DOUBLE: hold the opening line longer."]);
    await expect(still).toContainText("Watch or listen for");
    await expect(still).toContainText("TEST DOUBLE: listen for the music under the voice.");
    expect(c1.report.stillChange).toEqual([expect.objectContaining({ scene: 1, check: false, sceneId: c1.report.findings[0].sceneId }), expect.objectContaining({ scene: 0, check: true, sceneId: null })]);

    await page.getByRole("button", { name: "Apply 1 selected with the assistant" }).click();
    await expect(page.getByText(/^Applied:/)).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => (await view(request, id)).doc.scenes.some((s: { durationFrames: number }) => s.durationFrames === 210)).toBe(true);
    await expect(page.getByText("This review is of an earlier version.")).toBeVisible();

    await page.getByRole("button", { name: "Review this version again" }).click();
    await expect.poll(async () => (await critiques(request, id)).length, { timeout: 120_000 }).toBe(2);
    await expect(page.getByText("This review is of an earlier version.")).toHaveCount(0);
  });

  test("locked scenes get no automatic fix; Claude is required", async ({ page, request }) => {
    test.setTimeout(180_000);
    await scenario(request, "max");
    const created = await (await request.post("/api/projects", { data: { templateId: "motion-reel", title: "Critic locked", inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave" } } })).json();
    const id = created.project.id as string;
    const v = await view(request, id);
    await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: [{ op: "setSceneLock", sceneId: v.doc.scenes[0].id, locked: true }] } });
    expect((await request.post(`/api/projects/${id}/critique`, { data: {} })).status()).toBe(202);
    await expect.poll(async () => (await critiques(request, id)).length, { timeout: 120_000 }).toBe(1);
    const [c] = await critiques(request, id);
    expect(c.report.findings[0].request).toBe("");

    await page.goto(`/projects/${id}`);
    await page.getByRole("tab", { name: "critic" }).click();
    await expect(page.getByTestId("finding").first().getByRole("checkbox")).toHaveCount(0);

    await scenario(request, "signed_out");
    expect((await request.post(`/api/projects/${id}/critique`, { data: {} })).status()).toBe(412);
  });

  test("notes are read as problem and result; the assistant says which it achieved and what it would still change", async ({ page, request }) => {
    test.setTimeout(180_000);
    await scenario(request, "max");
    const created = await (await request.post("/api/projects", { data: { templateId: "motion-reel", title: "Notes", inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave" } } })).json();
    await page.goto(`/projects/${created.project.id}`);
    await page.getByRole("tab", { name: "assistant" }).click();
    await page.getByRole("radio", { name: "Whole project" }).click();
    await page.getByLabel("Ask the assistant").fill("The opening goes by too fast: it should be readable before it cuts.\nThe end card feels empty: it should feel finished.");
    await page.getByRole("button", { name: "Apply change" }).click();
    const read = page.getByTestId("notes-read");
    await expect(read).toBeVisible({ timeout: 60_000 });
    const notes = read.locator("li[data-done]");
    await expect(notes).toHaveCount(2);
    await expect(notes.nth(0)).toHaveAttribute("data-done", "true");
    await expect(notes.nth(0)).toContainText("TEST DOUBLE result for note 1");
    await expect(notes.nth(1)).toHaveAttribute("data-done", "false");
    await expect(page.getByTestId("assistant-still-change")).toContainText("TEST DOUBLE: the other notes need you.");
  });
});

