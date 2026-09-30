import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Phase 2 composer, against the Claude Agent SDK TEST DOUBLE (scripts/fake-claude-sdk.mjs),
 * which returns a canned proposal labelled "TEST DOUBLE". Real Claude output is not asserted.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const STATE = process.env.STUDIO_CLAUDE_SDK_DOUBLE_STATE ?? join(ROOT, "data", "fake-claude.json");

async function scenario(request: APIRequestContext, s: "signed_out" | "max") {
  writeFileSync(STATE, JSON.stringify({ scenario: s }));
  expect((await request.post("/api/settings/claude")).status()).toBe(200);
}
async function waitJob(request: APIRequestContext, id: string) {
  for (let i = 0; i < 240; i++) {
    const j = (await (await request.get(`/api/jobs/${id}`)).json()).job;
    if (["succeeded", "failed", "canceled", "paused"].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("job did not finish");
}

test.describe.serial("Composer", () => {
  test.afterAll(async ({ request }) => {
    await scenario(request, "signed_out");
  });

  test("prompt → review → create opens the editor with Claude's inputs (Quick effort)", async ({ page, request }) => {
    await scenario(request, "max");
    await page.goto("/projects/new");
    await expect(page.getByRole("heading", { name: "What are we making?" })).toBeVisible();
    await expect(page.getByTestId("estimate")).toContainText("Uses your Claude plan");

    await page.getByRole("button", { name: /^Effort:/ }).click();
    await page.getByRole("radio", { name: "Quick" }).click();
    await expect(page.getByTestId("estimate")).toContainText("about 1–3 requests");
    await page.keyboard.press("Escape");

    await page.getByRole("textbox", { name: "Describe the video" }).fill("Launch teaser for Tidewave, the calm calendar that protects focus time");
    await page.getByRole("button", { name: "Compose ↑" }).click();

    await expect(page.getByText("Claude suggests")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue(/^TEST DOUBLE: Launch teaser/);
    await expect(page.getByText("Template structure as is (Quick)")).toBeVisible();
    await page.getByRole("textbox", { name: "Title" }).fill("Composer teaser");
    await page.getByRole("button", { name: "Create video" }).click();

    await page.waitForURL(/\/projects\/prj_/, { timeout: 30_000 });
    await expect(page.getByRole("textbox", { name: "Project title" })).toHaveValue("Composer teaser");
    const id = page.url().split("/projects/")[1]!;
    const view = await (await request.get(`/api/projects/${id}`)).json();
    expect(view.doc.template.templateId).toBe("motion-reel");
    expect(view.doc.brief.inputs.hook).toBeTruthy();
    // Quick effort: no planning job was started.
    expect(view.jobs.some((j: { type: string }) => j.type === "plan")).toBe(false);
  });

  test("pinned settings are honoured and templates needing missing media are refused up front", async ({ request }) => {
    await scenario(request, "max");
    const r = await request.post("/api/compose", { data: { prompt: "A vertical teaser for Tidewave", templateId: "motion-reel", settings: { aspect: "9:16", durationSec: 15, music: "off", voice: "off" }, effort: "quick" } });
    expect(r.status()).toBe(202);
    const job = await waitJob(request, (await r.json()).job.id);
    expect(job.status).toBe("succeeded");
    expect(job.result).toMatchObject({ templateId: "motion-reel", aspect: "9:16", durationSec: 15, narration: false });

    const th = await request.post("/api/compose", { data: { prompt: "Cut my recording into highlights", templateId: "talking-head", effort: "quick" } });
    expect(th.status()).toBe(422);
    expect((await th.json()).error.message).toMatch(/attach/i);
  });

  test("without a ready Claude runtime the composer says so and cannot send", async ({ page, request }) => {
    await scenario(request, "signed_out");
    await page.goto("/projects/new");
    await page.getByRole("textbox", { name: "Describe the video" }).fill("Anything at all");
    await expect(page.getByRole("button", { name: "Compose ↑" })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Set up Claude" })).toBeVisible();
    const r = await request.post("/api/compose", { data: { prompt: "Anything at all" } });
    expect(r.status()).toBe(412);
    // The template forms remain available without Claude.
    await page.getByRole("button", { name: "Form" }).first().click();
    await expect(page.getByRole("button", { name: "← Back to the composer" })).toBeVisible();
  });
});
