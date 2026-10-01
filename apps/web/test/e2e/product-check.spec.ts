import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { apiUpload, createProject, FIX } from "./helpers";

/**
 * Product check: Claude (the Agent SDK TEST DOUBLE) compares generated takes with the shot's
 * reference photo. Takes come from the OpenRouter stand-in in scripts/fake-fal.ts. The double
 * answers "mismatch" (garbled logo) when the shot prompt contains TEST-MISMATCH.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const STATE = process.env.STUDIO_CLAUDE_SDK_DOUBLE_STATE ?? join(ROOT, "data", "fake-claude.json");
const STUB = "http://127.0.0.1:3910";
async function scenario(request: APIRequestContext, s: "signed_out" | "max") {
  writeFileSync(STATE, JSON.stringify({ scenario: s }));
  expect((await request.post("/api/settings/claude")).status()).toBe(200);
}
const view = async (request: APIRequestContext, id: string) => (await request.get(`/api/projects/${id}`)).json();
const ops = async (request: APIRequestContext, id: string, o: unknown[]) => {
  const v = await view(request, id);
  const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: o } });
  expect(r.status(), await r.text()).toBe(200);
};
const waitJob = async (request: APIRequestContext, jobId: string) => {
  for (let i = 0; i < 480; i++) {
    const cur = (await (await request.get(`/api/jobs/${jobId}`)).json()).job;
    if (["succeeded", "failed", "uncertain", "paused"].includes(cur.status)) return cur;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error("job did not finish");
};
const lastPromptImages = () => readFileSync(`${STATE}.log.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.event === "prompt").at(-1)?.images as number;

test.describe.serial("Product check", () => {
  test.beforeAll(async ({ request }) => {
    const up = await request.get(`${STUB}/__or`).catch(() => null);
    test.skip(!up || !up.ok(), "Start the stand-in: npx tsx scripts/fake-fal.ts (and set OPENROUTER_BASE_URL)");
  });
  test.afterAll(async ({ request }) => {
    await scenario(request, "signed_out");
    await request.patch("/api/settings/providers", { data: { provider: "openrouter", settings: {} } });
    await request.put("/api/settings/providers", { data: { provider: "openrouter", secret: null } });
  });

  test("Claude compares each take with the reference photo; a mismatch is shown and flagged in the guide", async ({ page, request }) => {
    test.setTimeout(360_000);
    await request.put("/api/settings/providers", { data: { provider: "openrouter", secret: "or-test-key" } });
    await request.patch("/api/settings/providers", { data: { provider: "openrouter", settings: { image: { model: "test/image-model", priceMicros: 50_000 }, preferForImages: true } } });

    const song = await apiUpload(request, join(FIX, "music-song.m4a"), "audio/mp4");
    const product = await apiUpload(request, join(FIX, "product-bottle-coral.png"), "image/png");
    const created = await createProject(request, { templateId: "anime-opening", title: "Product check", inputs: { song, excerptStart: 8, excerptEnd: 38, title: "Skyline Relay", synopsis: "Two couriers race across a floating city.", characters: ["Aki — swordswoman in a red coat"], direction: "cel-shaded anime" } });
    const id = created.project.id;
    await expect.poll(async () => (await view(request, id)).jobs.find((j: { type: string }) => j.type === "analyze_music")?.status, { timeout: 120_000 }).toBe("succeeded");
    await ops(request, id, [{ op: "setAcquisitionPolicy", policy: "generated-allowed" }]);
    await request.put(`/api/projects/${id}/budget`, { data: { projectCeilingMicros: 1_000_000, operationCeilingMicros: 500_000, unknownPriceRequestsAuthorized: 0 } });
    const shots = (await view(request, id)).doc.scenes.filter((s: { shot?: unknown }) => s.shot);
    const [s1, s2] = shots;
    await ops(request, id, [
      { op: "updateShot", sceneId: s1.id, patch: { kind: "image", referenceAssetIds: [product], prompt: "The coral bottle on a rooftop at dusk." } },
      { op: "updateShot", sceneId: s2.id, patch: { kind: "image", referenceAssetIds: [product], prompt: "The coral bottle in rain. TEST-MISMATCH" } },
    ]);
    const gen = await (await request.post(`/api/projects/${id}/shots/generate`, { data: { sceneIds: [s1.id, s2.id] } })).json();
    for (const j of gen.jobs) expect((await waitJob(request, j.id)).status).toBe("succeeded");

    // Not signed in: refused before anything is queued.
    await scenario(request, "signed_out");
    expect((await request.post(`/api/projects/${id}/shots/fidelity`, { data: {} })).ok()).toBe(false);

    await scenario(request, "max");
    await page.goto(`/projects/${id}`);
    await page.getByRole("tab", { name: "shots" }).click();
    const panel = page.getByTestId("product-check");
    await panel.getByRole("button", { name: "Check 2 takes with Claude" }).click();
    await expect(panel.getByRole("button", { name: "All takes checked" })).toBeVisible({ timeout: 120_000 });
    // One reference photo plus one frame of the image take, both sent as images.
    expect(lastPromptImages()).toBe(2);

    const doc = (await view(request, id)).doc;
    const verdict = (sceneId: string) => doc.scenes.find((s: { id: string }) => s.id === sceneId).shot.candidates[0].review;
    expect(verdict(s1.id).claude).toMatchObject({ verdict: "match", frames: 1 });
    expect(verdict(s2.id).claude).toMatchObject({ verdict: "mismatch" });
    expect(verdict(s2.id).claude.checks.find((c: { aspect: string }) => c.aspect === "logo")).toMatchObject({ result: "wrong" });
    expect(verdict(s2.id).decision).toBe("pending");
    expect(verdict(s2.id).paletteSimilarity).not.toBeNull();

    await expect(panel.getByText("1 mismatch")).toBeVisible();
    const bad = page.getByTestId(`shot-${shots.indexOf(s2) + 1}`).getByTestId("claude-fidelity");
    await expect(bad).toHaveAttribute("data-verdict", "mismatch");
    await bad.locator("summary").click();
    await expect(bad.getByText(/Logo: wrong/)).toBeVisible();

    // Once that take is used, the guide points at it until the owner decides.
    await page.getByTestId(`shot-${shots.indexOf(s2) + 1}`).getByRole("button", { name: "Use", exact: true }).click();
    await expect(page.getByTestId("flow-hint")).toContainText(`scene ${doc.scenes.findIndex((s: { id: string }) => s.id === s2.id) + 1} doesn't match your product`);
    await page.getByTestId(`shot-${shots.indexOf(s2) + 1}`).getByRole("button", { name: "Matches" }).click();
    await expect(page.getByTestId("flow-hint")).not.toContainText("doesn't match your product");

    // The owner cannot write Claude's verdict by hand.
    const v = await view(request, id);
    const forged = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: [{ op: "setShotFidelity", sceneId: s2.id, assetId: v.doc.scenes.find((s: { id: string }) => s.id === s2.id).shot.candidates[0].assetId, claude: { verdict: "match", summary: "x", checks: [], frames: 1, model: null, checkedAt: "now" } }] } });
    expect(forged.ok()).toBe(false);
  });

  test("with automatic checks on, each new take is checked without a click, and skipped quietly while Claude isn't set up", async ({ page, request }) => {
    test.setTimeout(360_000);
    await request.put("/api/settings/providers", { data: { provider: "openrouter", secret: "or-test-key" } });
    await request.patch("/api/settings/providers", { data: { provider: "openrouter", settings: { image: { model: "test/image-model", priceMicros: 50_000 }, preferForImages: true } } });
    const song = await apiUpload(request, join(FIX, "music-song.m4a"), "audio/mp4");
    const product = await apiUpload(request, join(FIX, "product-bottle-coral.png"), "image/png");
    const created = await createProject(request, { templateId: "anime-opening", title: "Auto product check", inputs: { song, excerptStart: 8, excerptEnd: 38, title: "Skyline Relay", synopsis: "Two couriers race across a floating city.", characters: ["Aki — swordswoman in a red coat"], direction: "cel-shaded anime" } });
    const id = created.project.id;
    await expect.poll(async () => (await view(request, id)).jobs.find((j: { type: string }) => j.type === "analyze_music")?.status, { timeout: 120_000 }).toBe("succeeded");
    await ops(request, id, [{ op: "setAcquisitionPolicy", policy: "generated-allowed" }]);
    await request.put(`/api/projects/${id}/budget`, { data: { projectCeilingMicros: 1_000_000, operationCeilingMicros: 500_000, unknownPriceRequestsAuthorized: 0 } });
    const [s1, s2] = (await view(request, id)).doc.scenes.filter((s: { shot?: unknown }) => s.shot);
    await ops(request, id, [
      { op: "updateShot", sceneId: s1.id, patch: { kind: "image", referenceAssetIds: [product], prompt: "The coral bottle on a rooftop at dusk." } },
      { op: "updateShot", sceneId: s2.id, patch: { kind: "image", referenceAssetIds: [product], prompt: "The coral bottle on a train platform at night." } },
    ]);

    await scenario(request, "max");
    await page.goto(`/projects/${id}`);
    await page.getByRole("tab", { name: "shots" }).click();
    const box = page.getByTestId("product-check").getByRole("checkbox", { name: /Check new takes automatically/ });
    await expect(box).not.toBeChecked();
    await box.click();
    await expect(box).toBeChecked();
    await expect.poll(async () => (await view(request, id)).doc.autoProductCheck).toBe(true);

    // Claude not set up: the take arrives, the automatic check steps aside without failing.
    await scenario(request, "signed_out");
    const g1 = await (await request.post(`/api/projects/${id}/shots/generate`, { data: { sceneIds: [s1.id] } })).json();
    for (const j of g1.jobs) expect((await waitJob(request, j.id)).status).toBe("succeeded");
    await expect.poll(async () => (await view(request, id)).jobs.find((j: { type: string }) => j.type === "check_fidelity")?.status, { timeout: 120_000 }).toBe("succeeded");
    let take = (await view(request, id)).doc.scenes.find((s: { id: string }) => s.id === s1.id).shot.candidates[0];
    expect(take.review?.claude).toBeUndefined();

    // Claude ready: the next new take is checked automatically.
    await scenario(request, "max");
    const g2 = await (await request.post(`/api/projects/${id}/shots/generate`, { data: { sceneIds: [s2.id] } })).json();
    for (const j of g2.jobs) expect((await waitJob(request, j.id)).status).toBe("succeeded");
    const checked = async () => (await view(request, id)).doc.scenes.find((s: { id: string }) => s.id === s2.id).shot.candidates.find((c: { review?: { claude?: unknown } }) => c.review?.claude);
    await expect.poll(checked, { timeout: 120_000 }).toBeTruthy();
    take = await checked();
    expect(take.review.claude.verdict).toBe("match");
  });
});
