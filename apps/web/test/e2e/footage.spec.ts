import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { ART, createProject } from "./helpers";

/**
 * Footage search & import (Internet Archive, Wikimedia Commons, Pexels, Pixabay) against the
 * TEST-ONLY footage API stand-in (scripts/fake-footage.ts, wired through FOOTAGE_*_BASE_URL).
 * Live APIs are unreachable from this environment; see docs/STATUS.md.
 */
const STUB = "http://127.0.0.1:3901";

async function waitJob(request: APIRequestContext, id: string) {
  for (let i = 0; i < 240; i++) {
    const j = (await (await request.get(`/api/jobs/${id}`)).json()).job;
    if (["succeeded", "failed", "canceled"].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("job timeout");
}
async function importItem(request: APIRequestContext, data: Record<string, unknown>) {
  const r = await request.post("/api/footage/import", { data: { rightsAcknowledged: true, ...data } });
  return { status: r.status(), body: await r.json() };
}
const asset = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/assets/${id}`)).json()).asset;

test.describe.serial("footage search and import", () => {
  test.beforeAll(async ({ request }) => {
    const up = await request.get(`${STUB}/__stats`).catch(() => null);
    test.skip(!up || !up.ok(), "Start the footage stand-in: npx tsx scripts/fake-footage.ts");
  });
  test.afterAll(async ({ request }) => {
    for (const provider of ["pexels", "pixabay"]) await request.put("/api/settings/providers", { data: { provider, secret: null } });
  });

  test("Internet Archive: search shows licences; public domain imports with provenance; unknown needs confirmation; NC is refused", async ({ request }) => {
    const r = await (await request.get("/api/footage/search?source=internet_archive&q=harbour&kind=video")).json();
    const byId = Object.fromEntries(r.items.map((i: { id: string }) => [i.id, i]));
    expect(byId.PrelingerHarbour1950.license).toMatchObject({ status: "public_domain", attributionRequired: false });
    expect(byId.HarbourNoLicense.license.status).toBe("unknown");
    expect(byId.HarbourNonCommercial.license.status).toBe("restricted");

    // The browser never supplies a download URL: extra fields are ignored and the item is re-resolved.
    const pd = await importItem(request, { source: "internet_archive", id: "PrelingerHarbour1950", kind: "video", url: "http://169.254.169.254/latest" });
    expect(pd.status).toBe(202);
    expect(pd.body.item.downloadUrl).toBe(`${STUB}/ia/download/PrelingerHarbour1950/harbour.mp4`);
    const job = await waitJob(request, pd.body.job.id);
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    const a = await asset(request, job.result.assetId);
    expect(a).toMatchObject({ kind: "video", status: "ready" });
    expect(a.name).toMatch(/^Harbour.Life.+1950.*\.mp4$/);
    expect(a.media.width).toBe(854);
    expect(a.provenance).toMatchObject({ source: "footage", footageSource: "internet_archive", footageId: "PrelingerHarbour1950", license: "Public domain (Mark 1.0)", licenseStatus: "public_domain", attributionRequired: false, pageUrl: "https://archive.org/details/PrelingerHarbour1950" });

    const unknown = await importItem(request, { source: "internet_archive", id: "HarbourNoLicense", kind: "video" });
    expect(unknown.status).toBe(409);
    expect(unknown.body.error.code).toBe("license_unconfirmed");
    const confirmed = await importItem(request, { source: "internet_archive", id: "HarbourNoLicense", kind: "video", confirmUnknownLicense: true });
    expect(confirmed.status).toBe(202);
    const cj = await waitJob(request, confirmed.body.job.id);
    // The stand-in serves the same bytes for both items, so this import deduplicates onto the
    // public-domain asset: its licence stays primary and the second source is kept alongside.
    expect(cj.result.deduplicated).toBe(true);
    const merged = (await asset(request, cj.result.assetId)).provenance;
    expect(merged.licenseStatus).toBe("public_domain");
    expect(merged.alsoFrom).toEqual(expect.arrayContaining([expect.objectContaining({ footageId: "HarbourNoLicense", licenseStatus: "unknown", licenseConfirmedByOwner: true })]));

    const nc = await importItem(request, { source: "internet_archive", id: "HarbourNonCommercial", kind: "video" });
    expect(nc.status).toBe(422);
    expect(nc.body.error.code).toBe("license_restricted");
    // Rights must be acknowledged.
    expect((await request.post("/api/footage/import", { data: { source: "internet_archive", id: "PrelingerHarbour1950", kind: "video" } })).status()).toBe(400);
  });

  test("Pexels and Pixabay need a key (kept server-side); imports carry the platform licence", async ({ request }) => {
    const before = await (await request.get("/api/footage/search?source=pexels&q=street&kind=video")).json();
    expect(before.error.code).toBe("footage_not_configured");
    for (const [provider, secret] of [["pexels", "pexels-test-key"], ["pixabay", "pixabay-test-key"]]) {
      expect((await request.put("/api/settings/providers", { data: { provider, secret } })).status()).toBe(200);
    }
    const sources = (await (await request.get("/api/footage/sources")).json()).sources;
    expect(sources.every((s: { available: boolean }) => s.available)).toBe(true);

    const px = await request.get("/api/footage/search?source=pexels&q=street&kind=video");
    const pxText = await px.text();
    expect(pxText).not.toContain("pexels-test-key");
    const pxItem = JSON.parse(pxText).items[0];
    expect(pxItem).toMatchObject({ title: "Busy city street at night", creator: "Sample Videographer", license: { status: "platform", name: "Pexels License" } });
    const pj = await waitJob(request, (await importItem(request, { source: "pexels", id: pxItem.id, kind: "video" })).body.job.id);
    expect(pj.status, JSON.stringify(pj.error)).toBe("succeeded");
    expect((await asset(request, pj.result.assetId)).provenance).toMatchObject({ footageSource: "pexels", license: "Pexels License", creator: "Sample Videographer" });

    const pb = await request.get("/api/footage/search?source=pixabay&q=lighthouse&kind=image");
    const pbText = await pb.text();
    expect(pbText).not.toContain("pixabay-test-key");
    const pbItem = JSON.parse(pbText).items[0];
    const bj = await waitJob(request, (await importItem(request, { source: "pixabay", id: pbItem.id, kind: "image" })).body.job.id);
    expect(bj.status, JSON.stringify(bj.error)).toBe("succeeded");
    expect(await asset(request, bj.result.assetId)).toMatchObject({ kind: "image", provenance: { footageSource: "pixabay", license: "Pixabay Content License" } });
  });

  test("Wikimedia Commons CC BY-SA clip → project credits list the required attribution; UI flow from the Assets page", async ({ request, page }) => {
    const r = await (await request.get("/api/footage/search?source=wikimedia&q=waves&kind=video")).json();
    const item = r.items[0];
    expect(item.license).toMatchObject({ status: "attribution", name: "CC BY-SA 4.0", attributionRequired: true });
    const job = await waitJob(request, (await importItem(request, { source: "wikimedia", id: item.id, kind: "video" })).body.job.id);
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    const wm = job.result.assetId as string;
    expect((await asset(request, wm)).kind).toBe("video");

    const created = await createProject(request, { templateId: "motion-reel", title: "Footage credits", inputs: { hook: "Hi", headline: "By the sea", brandName: "Tidewave" } });
    const id = created.project.id;
    const v = await (await request.get(`/api/projects/${id}`)).json();
    const op = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: [{ op: "setSceneBackground", sceneId: v.doc.scenes[0].id, background: { type: "asset", assetId: wm } }] } });
    expect(op.status(), await op.text()).toBe(200);
    const credits = await (await request.get(`/api/projects/${id}/credits`)).json();
    expect(credits.attributionRequired).toBe(true);
    expect(credits.creditsText).toMatch(/Waves at the pier.*Sample Photographer.*CC BY-SA 4\.0.*Wikimedia Commons/);

    // The Export tab shows the credit block.
    await page.goto(`/projects/${id}`);
    await page.getByRole("tab", { name: /^export$/i }).click();
    await expect(page.getByLabel("Footage credits")).toContainText("CC BY-SA 4.0");

    // UI: Assets → Find footage → Internet Archive → import the public-domain clip.
    await page.goto("/assets");
    await page.getByText(/Find free footage and images/).click();
    const panel = page.getByLabel("Find footage");
    await panel.getByRole("searchbox", { name: "Search footage" }).fill("harbour");
    await panel.getByRole("searchbox", { name: "Search footage" }).press("Enter");
    const card = panel.locator("li", { hasText: "Harbour Life (1950)" });
    await expect(card).toContainText("Public domain (Mark 1.0)");
    await expect(panel.locator("li", { hasText: "Harbour Documentary" }).getByRole("button", { name: "Import" })).toBeDisabled();
    await panel.getByLabel(/use imported items under their licence/).check();
    await card.getByRole("button", { name: "Import" }).click();
    await expect(card.getByRole("status")).toHaveText("Imported ✓", { timeout: 60_000 });
    await page.screenshot({ path: join(ART, "footage-assets.png"), fullPage: false });
    // No-licence item asks for explicit confirmation in the UI.
    const noLic = panel.locator("li", { hasText: "Harbour Home Movie" });
    await noLic.getByRole("button", { name: "Import" }).click();
    await expect(noLic).toContainText("No licence stated. Only continue if you checked");
    writeFileSync(join(ART, "footage-credits.json"), JSON.stringify(credits, null, 2));
  });

  test("the picker's footage search adds the clip to the selection without submitting the New Project form", async ({ page }) => {
    await page.goto("/projects/new?template=product-launch");
    await page.getByRole("button", { name: /Choose|Change/ }).first().click();
    await page.getByRole("button", { name: "Find free footage" }).first().click();
    const panel = page.getByLabel("Find footage").first();
    await panel.getByRole("searchbox", { name: "Search footage" }).fill("lighthouse");
    await panel.getByRole("tab", { name: /Pixabay/ }).click();
    await panel.getByRole("searchbox", { name: "Search footage" }).fill("lighthouse");
    await panel.getByRole("button", { name: "Search", exact: true }).click();
    await panel.getByLabel(/use imported items under their licence/).check();
    await panel.locator("li", { hasText: "Lighthouse" }).getByRole("button", { name: "Import" }).click();
    await expect(panel.locator("li", { hasText: "Lighthouse" }).getByRole("status")).toHaveText("Imported ✓", { timeout: 60_000 });
    await expect(page).toHaveURL(/\/projects\/new/);
    await expect(page.getByRole("button", { name: /Remove Lighthouse/ }).first()).toBeVisible();
  });

  test("Moving Image Archive (assisted, no automated access): record a direct link or an uploaded file with the shot's page", async ({ request, page }) => {
    const shot = "https://www.movingimagearchive.com/shots/harbour-cranes-1952";
    const base = { source: "moving_image_archive", pageUrl: shot, title: "Harbour cranes, 1952", confirmPublicDomain: true, rightsAcknowledged: true };
    // Validation: must be a movingimagearchive.com page, confirmed public domain, and one of file/link.
    expect((await request.post("/api/footage/manual", { data: { ...base, pageUrl: "https://example.com/x", fileUrl: `${STUB}/files/harbour.mp4` } })).status()).toBe(400);
    expect((await request.post("/api/footage/manual", { data: { ...base, confirmPublicDomain: false, fileUrl: `${STUB}/files/harbour.mp4` } })).status()).toBe(400);
    expect((await request.post("/api/footage/manual", { data: base })).status()).toBe(400);
    // Its tab is listed as an assisted source (no search requests are made to the site).
    const sources = (await (await request.get("/api/footage/sources")).json()).sources;
    expect(sources.find((x: { id: string }) => x.id === "moving_image_archive")).toMatchObject({ assisted: true, available: true });
    expect((await request.get("/api/footage/search?source=moving_image_archive&q=harbour")).status()).toBe(400);

    // Direct file link → imported through the guarded path, with the shot's record.
    const r = await request.post("/api/footage/manual", { data: { ...base, fileUrl: `${STUB}/files/street.mp4` } });
    expect(r.status(), await r.text()).toBe(202);
    const j = await waitJob(request, (await r.json()).job.id);
    expect(j.status, JSON.stringify(j.error)).toBe("succeeded");
    const p1 = (await asset(request, j.result.assetId)).provenance;
    // street.mp4 may already exist from the Pexels import (same bytes): then the record is kept alongside.
    const rec = p1.footageSource === "moving_image_archive" ? p1 : p1.alsoFrom.find((x: { footageSource: string }) => x.footageSource === "moving_image_archive");
    expect(rec).toMatchObject({ pageUrl: shot, licenseStatus: "public_domain", licenseConfirmedByOwner: true, title: "Harbour cranes, 1952" });

    // UI: upload a downloaded clip and record it.
    await page.goto("/assets");
    await page.getByText(/Find free footage and images/).click();
    const panel = page.getByLabel("Find footage");
    await panel.getByRole("tab", { name: "Moving Image Archive" }).click();
    const g = panel.getByRole("group", { name: "Moving Image Archive import" });
    await expect(g.getByRole("link", { name: /Open movingimagearchive\.com/ })).toHaveAttribute("href", "https://www.movingimagearchive.com/");
    await g.getByLabel("Shot page address").fill("https://www.movingimagearchive.com/shots/night-city-1958");
    await g.getByLabel("Title").fill("Night city, 1958");
    await g.locator('input[type="file"]').setInputFiles(join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "sample", "anime-night.mp4"));
    await g.getByLabel(/marks it as public domain/).check();
    await g.getByRole("button", { name: "Add to assets" }).click();
    await expect(g.getByRole("status")).toContainText("Recorded ✓", { timeout: 120_000 });
    await page.screenshot({ path: join(ART, "footage-mia.png") });
    const list = (await (await request.get("/api/assets?kind=video")).json()).assets as { provenance: Record<string, unknown> & { alsoFrom?: Record<string, unknown>[] } }[];
    const hit = list.flatMap((a) => [a.provenance, ...(a.provenance.alsoFrom ?? [])]).find((p) => p.pageUrl === "https://www.movingimagearchive.com/shots/night-city-1958");
    expect(hit).toMatchObject({ footageSource: "moving_image_archive", licenseStatus: "public_domain", attribution: expect.stringContaining("Moving Image Archive") });
  });
});
