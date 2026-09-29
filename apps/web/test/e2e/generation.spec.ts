/**
 * Generation pipeline against the TEST-ONLY fake fal queue (scripts/fake-fal.ts): the real
 * adapter, webhooks with Ed25519 signatures, budgets and recovery. This proves our side of
 * the contract; it does NOT verify live fal (no key, and fal is unreachable here).
 */
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { apiUpload, createProject, downloadAndProbe, FIX, frameAt, renderAndWait } from "./helpers";

const FAKE = "http://127.0.0.1:3900";
type Shot = { sceneId: string; purpose: string; shot: { status: string; acceptedAssetId?: string; candidates: { assetId: string }[]; variant: number; source: string }; fitsBudget: boolean | null };

async function stats(request: APIRequestContext) {
  return (await request.get(`${FAKE}/__stats`)).json();
}
async function shots(request: APIRequestContext, id: string) {
  return (await request.get(`/api/projects/${id}/shots`)).json();
}
async function settle(request: APIRequestContext, id: string, jobIds: string[], timeoutMs = 5 * 60_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await (await request.get(`/api/projects/${id}`)).json();
    const gen = v.jobs.filter((j: { id: string }) => jobIds.includes(j.id));
    if (gen.length === jobIds.length && gen.every((j: { status: string }) => ["succeeded", "failed", "canceled"].includes(j.status))) return { jobs: gen, view: v };
    if (Date.now() - t0 > timeoutMs) throw new Error("generation jobs did not settle");
    await new Promise((r) => setTimeout(r, 1000));
  }
}
async function generate(request: APIRequestContext, id: string, data: Record<string, unknown>) {
  const r = await request.post(`/api/projects/${id}/shots/generate`, { data });
  expect(r.status(), await r.text()).toBe(202);
  const j = await r.json();
  return settle(request, id, j.jobs.map((x: { id: string }) => x.id));
}
async function ops(request: APIRequestContext, id: string, list: unknown[]) {
  // Background jobs (music analysis, keyframes) may revise the project first: re-read on 409.
  for (let attempt = 0; ; attempt++) {
    const v = await (await request.get(`/api/projects/${id}`)).json();
    const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: list } });
    if (r.status() === 409 && attempt < 5) continue;
    expect(r.status(), await r.text()).toBe(200);
    return r.json();
  }
}

test.describe.serial("generation pipeline (A08, A09, A13) — fake provider", () => {
  let id = "";
  test.beforeAll(async ({ request }) => {
    expect((await request.get(`${FAKE}/__stats`)).ok(), "start scripts/fake-fal.ts first").toBe(true);
    await request.post(`${FAKE}/__control`, { data: { duplicateWebhooks: false, staleAfter: false, delayMs: 1500, webhooks: true } });
    expect((await request.put("/api/settings/providers", { data: { provider: "fal", secret: "test-fal-key-123" } })).status()).toBe(200);
    const set = await request.patch("/api/settings/providers", { data: { provider: "fal", settings: { video: { endpoint: "fake/anime-video", priceMicros: 250_000, priceCheckedAt: "test fixture", maxDurationSec: 5, notes: "TEST fixture price" }, image: { endpoint: "fake/anime-image", priceMicros: 50_000 } } } });
    expect(set.status(), await set.text()).toBe(200);
  });

  test("A09 + A13: budget stops spending; failures don't touch accepted shots; retry redoes only what's missing", async ({ request }) => {
    test.setTimeout(20 * 60_000);
    const song = await apiUpload(request, join(FIX, "music-song.m4a"), "audio/mp4");
    const created = await createProject(request, { templateId: "anime-opening", title: "E2E anime opening", inputs: { song, excerptStart: 8, excerptEnd: 38, title: "Skyline Relay", synopsis: "Two couriers race across a floating city to deliver a stolen star map.", characters: ["Aki — swordswoman in a red coat", "Ren — inventor with brass goggles"], direction: "cel-shaded anime, sunset palette" } });
    id = created.project.id;
    // Generation is an explicit owner choice (FR-15 acquisition policy).
    await ops(request, id, [{ op: "setAcquisitionPolicy", policy: "generated-allowed" }]);
    const list0 = await shots(request, id);
    expect(list0.shots).toHaveLength(6);
    expect(list0.shots.every((s: { estimate: { kind: string; micros: number } }) => s.estimate.kind === "known" && s.estimate.micros === 250_000)).toBe(true);
    // No budget yet: nothing may be spent.
    const submitsStart = (await stats(request)).submits;
    let r = await generate(request, id, {});
    expect(r.jobs.every((j: { status: string; error: { code: string } }) => j.status === "failed" && j.error.code === "no_budget")).toBe(true);
    const submits0 = (await stats(request)).submits;
    expect(submits0).toBe(submitsStart); // nothing was sent to the provider

    // Budget for four shots; shot 3 will fail at the provider.
    await request.put(`/api/projects/${id}/budget`, { data: { projectCeilingMicros: 1_000_000, operationCeilingMicros: 500_000, unknownPriceRequestsAuthorized: 0 } });
    const s3 = list0.shots[2] as Shot;
    await ops(request, id, [{ op: "updateShot", sceneId: s3.sceneId, patch: { prompt: "[fail] Character introduction" } }]);
    r = await generate(request, id, {});
    expect(r.jobs).toHaveLength(6);
    const st = await shots(request, id);
    const accepted = st.shots.filter((s: Shot) => s.shot.status === "accepted");
    const failed = st.shots.filter((s: Shot) => s.shot.status === "failed");
    expect(accepted.length).toBe(3);
    expect(failed.length).toBe(3); // one provider failure + two blocked by the budget
    const codes = r.jobs.map((j: { error?: { code: string } }) => j.error?.code).filter(Boolean).sort();
    expect(codes).toEqual(["budget_exceeded", "budget_exceeded", "provider_failed"]);
    expect((await stats(request)).submits - submits0).toBe(4); // blocked shots were never sent
    expect(st.totals.committedMicros).toBe(1_000_000); // 3 results + 1 failed-at-provider (may bill)

    // Retry: fix the prompt, raise the budget; only the three missing shots are generated.
    const acceptedBefore = Object.fromEntries(accepted.map((s: Shot) => [s.sceneId, s.shot.acceptedAssetId]));
    await ops(request, id, [{ op: "updateShot", sceneId: s3.sceneId, patch: { prompt: "Character introduction: Aki" } }]);
    await request.put(`/api/projects/${id}/budget`, { data: { projectCeilingMicros: 2_000_000, operationCeilingMicros: 500_000, unknownPriceRequestsAuthorized: 0 } });
    // The failed shot needs a new variant (a failed provider request isn't silently resent).
    await generate(request, id, { sceneIds: [s3.sceneId], regenerate: true });
    await generate(request, id, {});
    const st2 = await shots(request, id);
    expect(st2.shots.every((s: Shot) => s.shot.status === "accepted")).toBe(true);
    for (const [scene, asset] of Object.entries(acceptedBefore)) expect(st2.shots.find((s: Shot) => s.sceneId === scene).shot.acceptedAssetId).toBe(asset);
    expect((await stats(request)).submits - submits0).toBe(7);
    // Cost and job records survive a reload.
    expect(st2.ledger.filter((l: { status: string }) => l.status === "settled")).toHaveLength(7);
  });

  test("A08: duplicate and out-of-order callbacks give one result and a consistent ledger", async ({ request }) => {
    test.setTimeout(10 * 60_000);
    await request.post(`${FAKE}/__control`, { data: { duplicateWebhooks: true, staleAfter: true } });
    const st = await shots(request, id);
    const target = st.shots[0] as Shot;
    const before = await stats(request);
    await generate(request, id, { sceneIds: [target.sceneId], regenerate: true });
    // Give the trailing duplicate/stale webhooks time to arrive.
    await expect.poll(async () => (await stats(request)).webhooksSent - before.webhooksSent, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
    await new Promise((r) => setTimeout(r, 1500));
    const after = await shots(request, id);
    const shot = after.shots.find((s: Shot) => s.sceneId === target.sceneId) as Shot;
    expect(shot.shot.variant).toBe(target.shot.variant + 1);
    expect(shot.shot.candidates).toHaveLength(target.shot.candidates.length + 1);
    const opKey = `${id}:${target.sceneId}:v${target.shot.variant + 1}`;
    const rows = after.ledger.filter((l: { operationId: string }) => l.operationId === opKey);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("settled");
    expect((await stats(request)).submits - before.submits).toBe(1);
    // The accepted shot was kept (no silent replacement by the regenerated variant).
    expect(shot.shot.acceptedAssetId).toBe(target.shot.acceptedAssetId);
    await request.post(`${FAKE}/__control`, { data: { duplicateWebhooks: false, staleAfter: false } });
  });

  test("A09: unknown price requires an explicit bounded authorisation", async ({ request }) => {
    test.setTimeout(10 * 60_000);
    await request.patch("/api/settings/providers", { data: { provider: "fal", settings: { video: { endpoint: "fake/anime-video", priceMicros: null } } } });
    const st = await shots(request, id);
    const target = st.shots[1] as Shot;
    const before = await stats(request);
    let r = await generate(request, id, { sceneIds: [target.sceneId], regenerate: true });
    expect(r.jobs[0].error.code).toBe("unknown_price_unauthorized");
    expect((await stats(request)).submits).toBe(before.submits);
    await request.put(`/api/projects/${id}/budget`, { data: { projectCeilingMicros: 2_000_000, operationCeilingMicros: 500_000, unknownPriceRequestsAuthorized: 1 } });
    r = await generate(request, id, { sceneIds: [target.sceneId], regenerate: true });
    expect(r.jobs[0].status).toBe("succeeded");
    // The single authorisation is used up.
    r = await generate(request, id, { sceneIds: [target.sceneId], regenerate: true });
    expect(r.jobs[0].error.code).toBe("unknown_price_unauthorized");
    await request.patch("/api/settings/providers", { data: { provider: "fal", settings: { video: { endpoint: "fake/anime-video", priceMicros: 250_000 } } } });
  });

  test("webhooks without a valid token or signature are rejected", async ({ request }) => {
    const bad = await request.post("/api/providers/fal/webhook?g=gen_x&t=nope", { data: { status: "OK", request_id: "req_1", payload: {} } });
    expect(bad.status()).toBe(401);
  });

  test("T7 draft plays the provider-returned shots cut to the song", async ({ page, request }) => {
    test.setTimeout(20 * 60_000);
    const r = await renderAndWait(request, id, "preview");
    expect(r.job.status, JSON.stringify(r.job.error)).toBe("succeeded");
    const exp = r.view.exports.find((e: { jobId: string }) => e.jobId === r.job.id);
    expect(Math.abs(exp.durationSec - 30)).toBeLessThan(0.1);
    const { file } = await downloadAndProbe(page, exp.downloadUrl, "t7-anime-fake-provider.mp4");
    for (const [i, t] of [1, 7, 12, 17, 22, 27.5].entries()) frameAt(file, t, `t7-${i + 1}.png`);
  });
});
