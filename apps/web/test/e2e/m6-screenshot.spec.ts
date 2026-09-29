/**
 * FR-15 public-page screenshot: isolated capture through the SSRF guard. The page is served by
 * the TEST-ONLY fake server (allowed via the non-production VS_TEST_TRUSTED_OUTPUT seam); its
 * embedded requests to metadata/private addresses must be refused. Internal targets are refused.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ART } from "./helpers";

test("FR-15: website screenshot capture is isolated and SSRF-guarded", async ({ page, request }) => {
  test.setTimeout(5 * 60_000);
  // Internal target: refused before any browser starts.
  const bad = await (await request.post("/api/assets/screenshot", { data: { url: "http://127.0.0.1:3000/api/health" } })).json();
  let j;
  for (;;) {
    j = (await (await request.get(`/api/jobs/${bad.job.id}`)).json()).job;
    if (["succeeded", "failed"].includes(j.status)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(j.status).toBe("failed");
  expect(j.error.code).toMatch(/blocked_(address|port)/);

  // Fixture page through the UI.
  await page.goto("/assets");
  await page.getByLabel("Capture a public web page").fill("http://127.0.0.1:3900/__page");
  await page.getByRole("button", { name: "Capture screenshot" }).click();
  await expect(page.getByText(/captured \(\d+ request\(s\) to non-public addresses were blocked\)/)).toBeVisible({ timeout: 120_000 });
  const assets = (await (await request.get("/api/assets?kind=image")).json()).assets;
  const shot = assets.find((a: { name: string }) => a.name.startsWith("screenshot-127.0.0.1"));
  expect(shot.provenance).toMatchObject({ source: "screenshot", url: "http://127.0.0.1:3900/__page", title: "Fixture launch page" });
  expect(shot.provenance.retrievedAt).toBeTruthy();
  expect(shot.provenance.license).toMatch(/not a usage right/);
  const reasons = shot.provenance.blockedRequests.map((b: { url: string; reason: string }) => `${b.url} ${b.reason}`).join("\n");
  expect(reasons).toMatch(/169\.254\.169\.254.*blocked_address/);
  expect(reasons).toMatch(/127\.0\.0\.1:5432.*blocked_port/);
  expect(reasons).toMatch(/10\.0\.0\.1.*blocked_address/);
  expect(shot.media.width).toBe(1440);
  const img = await request.get(shot.url);
  writeFileSync(join(ART, "m6-screenshot.png"), await img.body());
});
