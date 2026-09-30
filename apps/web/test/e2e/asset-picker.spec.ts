import { expect, test } from "@playwright/test";

/**
 * Regression: the "Import from link" box lives inside other forms (New Project). It used to be a
 * nested <form>, which browsers drop, so Import/Enter submitted and reset the outer form.
 */
test("Import from link does not submit or wipe the New Project form", async ({ page, request }) => {
  const before = (await (await request.get("/api/projects")).json()).projects.length;
  await page.goto("/projects/new?template=product-launch");
  const title = page.getByLabel(/title/i).first();
  await title.fill("Picker regression");
  const picker = page.getByRole("group", { name: "Import from link" }).first();
  await page.getByRole("button", { name: /Choose|Change/ }).first().click();
  await page.getByLabel(/I have the rights/).first().check();
  const box = page.getByRole("textbox", { name: "Import from link" }).first();
  await box.fill("http://127.0.0.1:9/private.png"); // refused by the SSRF guard → an error, not a navigation
  await box.press("Enter");
  await expect(page.getByRole("alert").first()).toBeVisible();
  await page.getByRole("group", { name: "Import from link" }).first().getByRole("button", { name: "Import" }).click();
  await expect(page).toHaveURL(/\/projects\/new/);
  await expect(title).toHaveValue("Picker regression");
  await expect(picker).toBeVisible();
  expect((await (await request.get("/api/projects")).json()).projects.length).toBe(before);
});
