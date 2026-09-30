import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { apiUpload, createProject, FIX } from "./helpers";

/**
 * Phase 4 animatic gate against the TEST-ONLY stand-ins (scripts/fake-fal.ts: fal queue + OpenRouter).
 * Keyframes (OpenRouter images) → animatic draft render → owner approval → image-to-video (fal)
 * with each keyframe as the first frame. Video is refused until the animatic is approved.
 */
const FAKE = "http://127.0.0.1:3910";
const view = async (request: APIRequestContext, id: string) => (await request.get(`/api/projects/${id}`)).json();
const shots = async (request: APIRequestContext, id: string) => (await request.get(`/api/projects/${id}/shots`)).json();
async function ops(request: APIRequestContext, id: string, list: unknown[]) {
  for (let attempt = 0; ; attempt++) {
    const v = await view(request, id);
    const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: list } });
    if (r.status() === 409 && attempt < 5) continue;
    expect(r.status(), await r.text()).toBe(200);
    return r.json();
  }
}
const idle = async (request: APIRequestContext, id: string) =>
  expect.poll(async () => (await view(request, id)).jobs.filter((j: { type: string; status: string }) => ["generate_media", "preview"].includes(j.type) && ["queued", "running", "waiting_provider"].includes(j.status)).length, { timeout: 180_000 }).toBe(0);

test.describe.serial("Animatic gate", () => {
  test.beforeAll(async ({ request }) => {
    const up = await request.get(`${FAKE}/__or`).catch(() => null);
    test.skip(!up || !up.ok(), "Start scripts/fake-fal.ts (fal + OpenRouter stand-ins)");
    await request.post(`${FAKE}/__control`, { data: { duplicateWebhooks: false, staleAfter: false, delayMs: 500, webhooks: true } });
    await request.put("/api/settings/providers", { data: { provider: "fal", secret: "test-fal-key-123" } });
    await request.patch("/api/settings/providers", { data: { provider: "fal", settings: { video: { endpoint: "fake/anime-video", priceMicros: 250_000, maxDurationSec: 5 }, image: { endpoint: "fake/anime-image", priceMicros: 50_000 } } } });
    await request.put("/api/settings/providers", { data: { provider: "openrouter", secret: "or-test-key" } });
    await request.patch("/api/settings/providers", { data: { provider: "openrouter", settings: { image: { model: "test/image-model", priceMicros: 50_000 }, preferForImages: true } } });
  });
  test.afterAll(async ({ request }) => {
    await request.patch("/api/settings/providers", { data: { provider: "openrouter", settings: {} } });
    await request.put("/api/settings/providers", { data: { provider: "openrouter", secret: null } });
  });

  test("keyframes → animatic → approval → image-to-video from the keyframes", async ({ page, request }) => {
    test.setTimeout(900_000);
    const song = await apiUpload(request, join(FIX, "music-song.m4a"), "audio/mp4");
    const created = await createProject(request, { templateId: "anime-opening", title: "Animatic gate", inputs: { song, excerptStart: 8, excerptEnd: 38, title: "Skyline Relay", synopsis: "Two couriers race across a floating city.", characters: ["Aki — swordswoman in a red coat"], direction: "cel-shaded anime" } });
    const id = created.project.id;
    await expect.poll(async () => (await view(request, id)).jobs.find((j: { type: string }) => j.type === "analyze_music")?.status, { timeout: 120_000 }).toBe("succeeded");
    await ops(request, id, [{ op: "setAcquisitionPolicy", policy: "generated-allowed" }]);
    await request.put(`/api/projects/${id}/budget`, { data: { projectCeilingMicros: 3_000_000, operationCeilingMicros: 500_000, unknownPriceRequestsAuthorized: 0 } });
    const list = await shots(request, id);
    const n = list.keyframes.length;
    expect(n).toBeGreaterThan(0);
    expect(list.keyframeEstimate).toMatchObject({ kind: "known", micros: 50_000 });

    // 1. Keyframes, from the Shots tab.
    await page.goto(`/projects/${id}`);
    await page.getByRole("tab", { name: "shots" }).click();
    await page.getByRole("button", { name: `Generate ${n} keyframe${n > 1 ? "s" : ""}` }).click();
    await idle(request, id);
    await expect(page.getByRole("img", { name: /Keyframe for shot/ })).toHaveCount(n, { timeout: 30_000 });
    await expect(page.getByTestId("animatic-status")).toHaveText("awaiting approval");
    let v = await view(request, id);
    expect(v.doc.scenes.filter((s: { shot?: { keyframeAssetId?: string; status: string } }) => s.shot?.keyframeAssetId)).toHaveLength(n);
    // Keyframes don't count as footage: the shots are still pending.
    expect(v.doc.scenes.filter((s: { shot?: { status: string } }) => s.shot).every((s: { shot: { status: string } }) => s.shot.status === "pending")).toBe(true);

    // Video is refused while the animatic waits — nothing reaches fal.
    const submits = (await (await request.get(`${FAKE}/__stats`)).json()).submits;
    const refused = await request.post(`/api/projects/${id}/shots/generate`, { data: {} });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.code).toBe("animatic_not_approved");
    expect((await (await request.get(`${FAKE}/__stats`)).json()).submits).toBe(submits);

    // 2. The animatic: a draft render with keyframes as stills.
    await page.getByRole("button", { name: "Render the animatic" }).click();
    // Wait for the render itself (an idle check can run before the job exists).
    await expect.poll(async () => { const x = await view(request, id); return x.exports.some((e: { revisionId: string }) => e.revisionId === x.revision.id); }, { timeout: 300_000 }).toBe(true);
    v = await view(request, id);
    const draft = v.exports.find((e: { revisionId: string }) => e.revisionId === v.revision.id);
    expect(draft.warnings.join(" ")).toMatch(/shows its keyframe \(animatic\)/);
    expect(draft.warnings.join(" ")).not.toMatch(/has no footage yet/);

    // 3. Approve; a redone keyframe reopens approval.
    await page.getByRole("button", { name: "Approve the animatic" }).click();
    await expect(page.getByTestId("animatic-status")).toHaveText("approved");
    await page.getByRole("button", { name: "Redo keyframe for shot 1" }).click();
    await expect.poll(async () => (await view(request, id)).doc.animatic.status, { timeout: 120_000 }).toBe("pending");
    await idle(request, id);
    await ops(request, id, [{ op: "setAnimaticStatus", status: "approved" }]);

    // 4. Video from the keyframes: every fal request carries a first-frame image.
    const before = (await (await request.get(`${FAKE}/__stats`)).json()).requests.length;
    const r = await request.post(`/api/projects/${id}/shots/generate`, { data: {} });
    expect(r.status(), await r.text()).toBe(202);
    await idle(request, id);
    const sent = (await (await request.get(`${FAKE}/__stats`)).json()).requests.slice(before);
    expect(sent).toHaveLength(n);
    expect(sent.every((x: { endpoint: string; hasImageUrl: boolean }) => x.endpoint === "fake/anime-video" && x.hasImageUrl)).toBe(true);
    v = await view(request, id);
    expect(v.doc.scenes.filter((s: { shot?: { status: string } }) => s.shot).every((s: { shot: { status: string } }) => s.shot.status === "accepted")).toBe(true);
    // Budget: n keyframes settled at OpenRouter's reported cost + 1 redo, n videos at the fal price.
    const ledger = (await shots(request, id)).ledger as { status: string; actualMicros: number | null }[];
    const settled = ledger.filter((l) => l.status === "settled").map((l) => l.actualMicros);
    expect(settled.filter((m) => m === 39_000)).toHaveLength(n + 1);
    expect(settled.filter((m) => m === 250_000)).toHaveLength(n);
  });
});
