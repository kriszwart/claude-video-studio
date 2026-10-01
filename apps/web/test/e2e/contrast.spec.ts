import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Measured text contrast on real frames (Quality review), handed to the visual critic (Claude
 * Agent SDK TEST DOUBLE) to turn into a concrete fix. One headline is set to dark indigo on the
 * template's indigo background; the template's own text must not be flagged.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const STATE = process.env.STUDIO_CLAUDE_SDK_DOUBLE_STATE ?? join(ROOT, "data", "fake-claude.json");
async function scenario(request: APIRequestContext, s: "signed_out" | "max") {
  writeFileSync(STATE, JSON.stringify({ scenario: s }));
  expect((await request.post("/api/settings/claude")).status()).toBe(200);
}
const view = async (request: APIRequestContext, id: string) => (await request.get(`/api/projects/${id}`)).json();

test.describe.serial("Text contrast", () => {
  test.afterAll(async ({ request }) => {
    await scenario(request, "signed_out");
  });

  test("low-contrast text is measured, reported with its ratio, and the critic proposes a fix", async ({ page, request }) => {
    test.setTimeout(300_000);
    await scenario(request, "max");
    const created = await (await request.post("/api/projects", { data: { templateId: "motion-reel", title: "Contrast", inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave" } } })).json();
    const id = created.project.id as string;
    const v = await view(request, id);
    const scene = v.doc.scenes[0];
    const text = scene.layers.find((l: { kind: string }) => l.kind === "text");
    const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: [{ op: "setLayerStyle", sceneId: scene.id, layerId: text.id, style: { color: "#2b2d6b" } }] } });
    expect(r.ok(), await r.text()).toBe(true);

    await page.goto(`/projects/${id}`);
    await page.getByRole("tab", { name: /export/i }).click();
    await page.getByRole("button", { name: "Review & repair draft" }).click();
    const report = page.getByTestId("quality-report");
    await expect(report).toContainText("low contrast", { timeout: 180_000 });
    await expect(report).toContainText(/\d\.\d:1 — text #2b2d6b/);

    const q = (await (await request.get(`/api/projects/${id}/quality`)).json()).reports[0];
    const contrast = q.report.passes.at(-1).issues.filter((i: { code: string }) => i.code === "low_contrast");
    // Only the darkened headline; the template's own text passes.
    expect(contrast).toHaveLength(1);
    expect(contrast[0]).toMatchObject({ sceneId: scene.id, layerId: text.id, repairable: false });
    expect(q.report.passes.at(-1).evidence.some((e: { why: string }) => e.why === "low_contrast")).toBe(true);

    await page.getByRole("tab", { name: "critic" }).click();
    await page.getByRole("button", { name: "Review this version" }).click();
    await expect(page.getByTestId("critique")).toBeVisible({ timeout: 120_000 });
    const c = (await (await request.get(`/api/projects/${id}/critique`)).json()).critiques[0];
    expect(c.report.contrast).toHaveLength(1);
    expect(c.report.contrast[0]).toMatchObject({ scene: 1, layerId: text.id, textColor: "#2b2d6b" });
    // Sent to Claude, not hidden as a measured issue, and turned into a fix with the ratio.
    expect(c.report.measured.some((m: { code: string }) => m.code === "low_contrast")).toBe(false);
    const finding = c.report.findings.find((f: { observation: string }) => f.observation.includes(":1 against"));
    expect(finding).toMatchObject({ scene: 1, category: "readability", request: expect.stringContaining("#ffffff") });
    await expect(page.getByTestId("critique")).toContainText(`measures ${c.report.contrast[0].ratio}:1`);
  });
});
