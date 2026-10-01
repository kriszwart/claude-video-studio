import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";

/** Settings → Get started reflects live state: Claude (TEST DOUBLE scenarios) and the running worker. */
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const STATE = process.env.STUDIO_CLAUDE_SDK_DOUBLE_STATE ?? join(ROOT, "data", "fake-claude.json");
async function scenario(request: APIRequestContext, s: "signed_out" | "max") {
  writeFileSync(STATE, JSON.stringify({ scenario: s }));
  expect((await request.post("/api/settings/claude")).status()).toBe(200);
}

test.describe.serial("Setup checklist", () => {
  test.afterAll(async ({ request }) => {
    await scenario(request, "signed_out");
  });

  test("names what's missing and turns ready once Claude is signed in", async ({ page, request }) => {
    await scenario(request, "signed_out");
    await page.goto("/settings");
    const box = page.getByTestId("get-started");
    await expect(box.getByTestId("setup-ready")).toHaveText("Setup needed");
    await expect(box.locator('[data-check="claude"]')).toHaveAttribute("data-state", "missing");
    await expect(box.locator('[data-check="claude"]')).toContainText("not signed in");
    // A worker is running in the test environment (software rendering here).
    await expect(box.locator('[data-check="worker"]')).toHaveAttribute("data-state", /ok|warn/);
    // Each item links to the section that fixes it.
    await expect(box.getByRole("link", { name: "Claude" })).toHaveAttribute("href", "#claude");

    await scenario(request, "max");
    await page.reload();
    await expect(box.getByTestId("setup-ready")).toHaveText("Ready for your first video");
    await expect(box.locator('[data-check="claude"]')).toHaveAttribute("data-state", "ok");
    await expect(box.getByRole("link", { name: "New project" })).toBeVisible();
  });
});
