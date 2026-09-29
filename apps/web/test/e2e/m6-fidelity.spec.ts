/**
 * A23 physical product fidelity, using the TEST-ONLY fake fal queue (its output is a synthetic
 * test pattern, i.e. a deliberately wrong product). Proves our review path, not live fal.
 */
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiUpload, ART, createProject, FIX } from "./helpers";

const FAKE = "http://127.0.0.1:3900";

test("A23: generated product shot is checked against the approved photo, flagged, reviewable and replaceable", async ({ page, request }) => {
  test.setTimeout(15 * 60_000);
  expect((await request.get(`${FAKE}/__stats`)).ok(), "start scripts/fake-fal.ts first").toBe(true);
  await request.post(`${FAKE}/__control`, { data: { duplicateWebhooks: false, staleAfter: false, delayMs: 800, webhooks: true } });
  expect((await request.put("/api/settings/providers", { data: { provider: "fal", secret: "test-fal-key-123" } })).status()).toBe(200);
  await request.patch("/api/settings/providers", { data: { provider: "fal", settings: { video: { endpoint: "fake/anime-video", priceMicros: 250_000, priceCheckedAt: "test fixture", maxDurationSec: 5, notes: "TEST fixture price" }, image: { endpoint: "fake/anime-image", priceMicros: 50_000 } } } });

  const teal = await apiUpload(request, join(FIX, "product-bottle-teal.png"), "image/png");
  const coral = await apiUpload(request, join(FIX, "product-bottle-coral.png"), "image/png");
  const created = await createProject(request, { templateId: "product-spec-ad", title: "A23 fidelity", inputs: { productName: "Tidewave Bottle", catalog: [teal, coral], details: ["Keeps drinks cold 24 h", "750 ml"], cta: "tidewave.example", lifestyle: "yes" } });
  const id = created.project.id;
  const before = (await (await request.get(`/api/projects/${id}`)).json()).doc;
  const catalogIn = (d: { scenes: { recipeSlot: string; layers: { kind: string; assetId?: string }[] }[] }) => d.scenes.filter((s) => s.recipeSlot !== "lifestyle").flatMap((s) => s.layers.filter((l) => l.kind === "image").map((l) => l.assetId));
  // P6 starts uploads-only; generation is an explicit owner choice (FR-15 acquisition policy).
  const blocked = await request.post(`/api/projects/${id}/shots/generate`, { data: {} });
  expect(blocked.status()).toBe(409);
  const pv = await (await request.get(`/api/projects/${id}`)).json();
  expect((await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: pv.revision.id, ops: [{ op: "setAcquisitionPolicy", policy: "generated-allowed" }] } })).status()).toBe(200);
  await request.put(`/api/projects/${id}/budget`, { data: { projectCeilingMicros: 1_000_000, operationCeilingMicros: 500_000, unknownPriceRequestsAuthorized: 0 } });
  const g = await request.post(`/api/projects/${id}/shots/generate`, { data: {} });
  expect(g.status(), await g.text()).toBe(202);
  const jobIds = (await g.json()).jobs.map((j: { id: string }) => j.id);
  let v;
  for (let i = 0; ; i++) {
    v = await (await request.get(`/api/projects/${id}`)).json();
    const js = v.jobs.filter((j: { id: string }) => jobIds.includes(j.id));
    if (js.every((j: { status: string }) => ["succeeded", "failed"].includes(j.status))) break;
    if (i > 300) throw new Error("generation did not settle");
    await new Promise((r) => setTimeout(r, 1000));
  }
  const scene = v.doc.scenes.find((s: { shot?: unknown }) => s.shot);
  const cand = scene.shot.candidates[0];
  // Measured check against the approved reference: flagged, not auto-accepted, reference kept for review.
  expect(cand.review).toMatchObject({ referenceAssetId: teal, flagged: true, decision: "pending" });
  expect(cand.review.method).toMatch(/colour only/);
  expect(scene.shot.acceptedAssetId).toBeUndefined();
  expect(scene.shot.status).toBe("ready");
  // Approved catalog photos elsewhere are untouched.
  expect(catalogIn(v.doc)).toEqual(catalogIn(before));

  await page.goto(`/projects/${id}`);
  await page.getByRole("tab", { name: /shots/i }).click();
  await expect(page.getByTestId("shot-reference").first()).toBeVisible();
  await expect(page.getByTestId("fidelity").first()).toContainText(/Colour mismatch vs reference/);
  await page.screenshot({ path: join(ART, "m6-fidelity-review.png"), fullPage: true });
  await page.getByRole("button", { name: "Reject" }).first().click();
  await expect(page.getByTestId("fidelity").first()).toContainText("Rejected");

  // Replace with the owner's own footage instead (supplied), which is accepted as-is.
  const own = await apiUpload(request, join(FIX, "broll-dashboard-pan.mp4"), "video/mp4");
  const cur = await (await request.get(`/api/projects/${id}`)).json();
  const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: cur.revision.id, ops: [{ op: "acceptShot", sceneId: scene.id, assetId: own, supplied: true }] } });
  expect(r.status(), await r.text()).toBe(200);
  const after = (await r.json()).doc ?? (await (await request.get(`/api/projects/${id}`)).json()).doc;
  const s2 = after.scenes.find((s: { id: string }) => s.id === scene.id);
  expect(s2.shot).toMatchObject({ source: "supplied", status: "accepted", acceptedAssetId: own });
  expect(s2.shot.candidates[0].review.decision).toBe("rejected");
  expect(catalogIn(after)).toEqual(catalogIn(before));
});
