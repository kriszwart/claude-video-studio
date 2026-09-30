import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { apiUpload, createProject, FIX } from "./helpers";

/**
 * Phase 4 OpenRouter image shots against the TEST-ONLY stand-in in scripts/fake-fal.ts
 * (OPENROUTER_BASE_URL). Verifies the documented request shape, reference images, the budget
 * gate, settling at the reported cost, and release on a definite rejection.
 */
const STUB = "http://127.0.0.1:3910";
const view = async (request: APIRequestContext, id: string) => (await request.get(`/api/projects/${id}`)).json();
const ops = async (request: APIRequestContext, id: string, o: unknown[]) => {
  const v = await view(request, id);
  const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: o } });
  expect(r.status(), await r.text()).toBe(200);
};
const generate = async (request: APIRequestContext, id: string, sceneIds: string[], regenerate = false) => {
  const r = await (await request.post(`/api/projects/${id}/shots/generate`, { data: { sceneIds, regenerate } })).json();
  const out = [];
  for (const j of r.jobs) {
    for (let i = 0; i < 240; i++) {
      const cur = (await (await request.get(`/api/jobs/${j.id}`)).json()).job;
      if (["succeeded", "failed", "uncertain"].includes(cur.status)) {
        out.push(cur);
        break;
      }
      await new Promise((res) => setTimeout(res, 500));
    }
  }
  return out;
};

test.describe.serial("OpenRouter image shots", () => {
  test.beforeAll(async ({ request }) => {
    const up = await request.get(`${STUB}/__or`).catch(() => null);
    test.skip(!up || !up.ok(), "Start the stand-in: npx tsx scripts/fake-fal.ts (and set OPENROUTER_BASE_URL)");
  });
  test.afterAll(async ({ request }) => {
    await request.patch("/api/settings/providers", { data: { provider: "openrouter", settings: {} } });
    await request.put("/api/settings/providers", { data: { provider: "openrouter", secret: null } });
  });

  test("image shots go through OpenRouter with references, budget-gated, settled at the reported cost", async ({ page, request }) => {
    test.setTimeout(300_000);
    await request.put("/api/settings/providers", { data: { provider: "openrouter", secret: "or-test-key" } });
    await page.goto("/settings");
    const form = page.getByRole("form", { name: "OpenRouter image model" });
    await form.getByRole("textbox", { name: "OpenRouter image model id" }).fill("test/image-model");
    await form.getByRole("textbox", { name: "OpenRouter price per image" }).fill("0.05");
    await form.getByRole("button", { name: "Save OpenRouter model" }).click();
    await expect.poll(async () => ((await (await request.get("/api/settings/providers")).json()).providers.find((p: { provider: string }) => p.provider === "openrouter").settings.image?.model)).toBe("test/image-model");

    const song = await apiUpload(request, join(FIX, "music-song.m4a"), "audio/mp4");
    const product = await apiUpload(request, join(FIX, "product-bottle-coral.png"), "image/png");
    const created = await createProject(request, { templateId: "anime-opening", title: "OpenRouter shots", inputs: { song, excerptStart: 8, excerptEnd: 38, title: "Skyline Relay", synopsis: "Two couriers race across a floating city.", characters: ["Aki — swordswoman in a red coat"], direction: "cel-shaded anime" } });
    const id = created.project.id;
    // The song is analysed first and the shots are built from it; edit only after that.
    await expect.poll(async () => (await view(request, id)).jobs.find((j: { type: string }) => j.type === "analyze_music")?.status, { timeout: 120_000 }).toBe("succeeded");
    await ops(request, id, [{ op: "setAcquisitionPolicy", policy: "generated-allowed" }]);
    const v = await view(request, id);
    const shotScenes = v.doc.scenes.filter((s: { shot?: unknown }) => s.shot);
    const s1 = shotScenes[0];
    await ops(request, id, [{ op: "updateShot", sceneId: s1.id, patch: { kind: "image", referenceAssetIds: [product] } }]);

    const list = await (await request.get(`/api/projects/${id}/shots`)).json();
    expect(list.imageVia).toBe("openrouter");
    const row = list.shots.find((x: { sceneId: string }) => x.sceneId === s1.id);
    expect(row).toMatchObject({ provider: "openrouter", model: "test/image-model", estimate: { kind: "known", micros: 50_000 } });

    // No budget: refused before anything is sent.
    const before = ((await (await request.get(`${STUB}/__or`)).json()) as unknown[]).length;
    const [refused] = await generate(request, id, [s1.id]);
    expect(refused).toMatchObject({ status: "failed", error: { code: "no_budget" } });
    expect(((await (await request.get(`${STUB}/__or`)).json()) as unknown[]).length).toBe(before);

    await request.put(`/api/projects/${id}/budget`, { data: { projectCeilingMicros: 1_000_000, operationCeilingMicros: 500_000, unknownPriceRequestsAuthorized: 0 } });
    const [ok] = await generate(request, id, [s1.id]);
    expect(ok.status, JSON.stringify(ok.error)).toBe("succeeded");
    const sent = ((await (await request.get(`${STUB}/__or`)).json()) as Record<string, unknown>[]).at(-1)!;
    expect(sent).toMatchObject({ model: "test/image-model", modalities: ["image", "text"], imageConfig: { aspect_ratio: "16:9" }, usage: { include: true }, references: 1 });

    const after = await view(request, id);
    const shot = after.doc.scenes.find((s: { id: string }) => s.id === s1.id).shot;
    expect(shot.candidates.at(-1)).toMatchObject({ provider: "openrouter", assetId: ok.result.assetId });
    const asset = (await (await request.get(`/api/assets/${ok.result.assetId}`)).json()).asset;
    expect(asset).toMatchObject({ kind: "image", generated: true, provenance: { provider: "openrouter", model: "test/image-model", reportedCostUsd: 0.039 } });
    expect(asset.media).toMatchObject({ width: 1024, height: 576 });
    // Settled at the cost OpenRouter reported ($0.039), not the $0.05 estimate.
    const ledger = (await (await request.get(`/api/projects/${id}/shots`)).json()).ledger as { status: string; actualMicros: number | null }[];
    expect(ledger.some((l) => l.status === "settled" && l.actualMicros === 39_000)).toBe(true);
    expect(ok.result.fidelity).not.toBeNull();

    // A definite rejection (insufficient credits) releases the reservation.
    await ops(request, id, [{ op: "updateShot", sceneId: s1.id, patch: { prompt: "CREDITS test" } }]);
    const [broke] = await generate(request, id, [s1.id], true);
    expect(broke).toMatchObject({ status: "failed", error: { code: "provider_failed", message: "Your OpenRouter account has insufficient credits." } });
    const l2 = (await (await request.get(`/api/projects/${id}/shots`)).json()).ledger as { status: string }[];
    expect(l2.filter((l) => l.status === "released")).toHaveLength(1);
  });
});
