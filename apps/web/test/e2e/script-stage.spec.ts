import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Phase 2 script stage against the Claude Agent SDK TEST DOUBLE. The double's first script
 * contains stock phrasing ("Let's dive in"), so the studio's lint-and-repair loop must remove it.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const STATE = process.env.STUDIO_CLAUDE_SDK_DOUBLE_STATE ?? join(ROOT, "data", "fake-claude.json");
async function scenario(request: APIRequestContext, s: "signed_out" | "max") {
  writeFileSync(STATE, JSON.stringify({ scenario: s }));
  expect((await request.post("/api/settings/claude")).status()).toBe(200);
}
const view = async (request: APIRequestContext, id: string) => (await request.get(`/api/projects/${id}`)).json();

test.describe.serial("Script stage", () => {
  test.afterAll(async ({ request }) => {
    await scenario(request, "signed_out");
  });

  test("composer (Standard) → script draft → edit with live style check → approve → plan keeps narration verbatim", async ({ page, request }) => {
    test.setTimeout(180_000);
    await scenario(request, "max");
    await page.goto("/projects/new");
    await page.getByRole("button", { name: /Auto · Auto length/ }).click();
    await page.getByRole("combobox", { name: "Voiceover" }).selectOption("off");
    await page.getByRole("combobox", { name: "Writing style" }).selectOption("professor");
    await page.keyboard.press("Escape");
    await page.getByRole("textbox", { name: "Describe the video" }).fill("Explain focus time for Tidewave users");
    await page.getByRole("button", { name: "Compose ↑" }).click();
    await expect(page.getByText(/Script first \(University professor\)/)).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Create video" }).click();
    await page.waitForURL(/\/projects\/prj_/);
    const id = page.url().split("/projects/")[1]!;

    // The Script tab opens by itself and shows the draft once Claude has written it.
    await expect(page.getByRole("tab", { name: "script" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("script-status")).toHaveText(/Draft/, { timeout: 60_000 });
    const v1 = await view(request, id);
    const script = v1.doc.script;
    expect(script.style).toBe("professor");
    expect(script.beats.length).toBeGreaterThan(1);
    // Voice off in the composer → no narration, and the repaired draft has no stock phrasing.
    expect(script.narrated).toBe(false);
    const writeJob = v1.jobs.find((j: { type: string }) => j.type === "write_script");
    expect(writeJob.status).toBe("succeeded");

    // Editing a line runs the same style check live.
    const first = page.getByRole("textbox", { name: "On-screen line 1" });
    await first.fill("Let's dive in to focus time");
    await first.blur();
    await expect(page.getByText(/Stock phrasing "Let's dive in"/)).toBeVisible();
    await first.fill("What focus time is");
    await first.blur();
    await expect(page.getByText(/Stock phrasing/)).toHaveCount(0);

    await page.getByRole("button", { name: "Approve script & plan storyboard" }).click();
    await expect(page.getByTestId("script-status")).toHaveText("Approved");
    // Planning builds exactly one scene per beat, in order.
    await expect.poll(async () => {
      const v = await view(request, id);
      return v.jobs.find((j: { type: string }) => j.type === "plan")?.status;
    }, { timeout: 60_000 }).toBe("succeeded");
    const v2 = await view(request, id);
    expect(v2.doc.scenes.length).toBe(v2.doc.script.beats.length);
    v2.doc.scenes.forEach((s: { recipeSlot: string; layers: { kind: string; text?: string }[] }, i: number) => {
      expect(s.recipeSlot).toBe(v2.doc.script.beats[i].recipeSlot);
    });
    expect(v2.doc.scenes[0].layers.some((l: { kind: string; text?: string }) => l.kind === "text" && l.text === "What focus time is")).toBe(true);
  });

  test("narrated scripts are repaired, and editing an approved script reopens it", async ({ request }) => {
    await scenario(request, "max");
    const created = await (await request.post("/api/projects", { data: { templateId: "motion-reel", title: "Script API", inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave" }, script: { style: "plain", narrated: true } } })).json();
    const id = created.project.id;
    await expect.poll(async () => (await view(request, id)).doc.script?.status, { timeout: 60_000 }).toBe("draft");
    const v = await view(request, id);
    const job = v.jobs.find((j: { type: string }) => j.type === "write_script");
    expect(job.result.attempts).toBeGreaterThanOrEqual(2);
    for (const b of v.doc.script.beats) expect(b.narration).not.toMatch(/dive in/i);

    const op = (ops: unknown[], base: string) => request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: base, ops } });
    const a = await (await op([{ op: "setScriptStatus", status: "approved" }], v.revision.id)).json();
    expect(a.doc.script.status).toBe("approved");
    const b = await (await op([{ op: "updateScriptBeat", beatId: a.doc.script.beats[0].id, patch: { narration: "A plainer opening line." } }], a.revisionId)).json();
    expect(b.doc.script.status).toBe("draft");
  });
});
