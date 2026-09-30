import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";

/** Phase 2 shot-plan review against the Claude Agent SDK TEST DOUBLE. */
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const STATE = process.env.STUDIO_CLAUDE_SDK_DOUBLE_STATE ?? join(ROOT, "data", "fake-claude.json");
async function scenario(request: APIRequestContext, s: "signed_out" | "max") {
  writeFileSync(STATE, JSON.stringify({ scenario: s }));
  expect((await request.post("/api/settings/claude")).status()).toBe(200);
}
const view = async (request: APIRequestContext, id: string) => (await request.get(`/api/projects/${id}`)).json();
const jobsOf = (v: { jobs: { type: string; status: string }[] }, type: string) => v.jobs.filter((j) => j.type === type);

/** A project whose approved script has been planned for review. */
async function plannedForReview(request: APIRequestContext, title: string, narration?: { voiceId: string }) {
  const created = await (await request.post("/api/projects", { data: { templateId: "motion-reel", title, inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave" }, script: { style: "plain", narrated: !!narration } } })).json();
  const id = created.project.id as string;
  await expect.poll(async () => (await view(request, id)).doc.script?.status, { timeout: 60_000 }).toBe("draft");
  const v = await view(request, id);
  const a = await (await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: [{ op: "setScriptStatus", status: "approved" }] } })).json();
  expect((await request.post(`/api/projects/${id}/plan`, { data: { baseRevisionId: a.revisionId, review: true, ...(narration ? { narration } : {}) } })).status()).toBe(202);
  await expect.poll(async () => jobsOf(await view(request, id), "plan")[0]?.status, { timeout: 60_000 }).toBe("succeeded");
  return id;
}

test.describe.serial("Shot plan review", () => {
  test.afterAll(async ({ request }) => {
    await scenario(request, "signed_out");
  });

  test("frames per shot, revise one shot, replan with a note, approve & render a draft", async ({ page, request }) => {
    test.setTimeout(240_000);
    await scenario(request, "max");
    const id = await plannedForReview(request, "Shot plan UI");
    const v = await view(request, id);
    expect(v.doc.review).toMatchObject({ status: "pending" });

    await page.goto(`/projects/${id}`);
    await expect(page.getByRole("heading", { name: "Shot plan" })).toBeVisible();
    const cards = page.getByTestId("shot-card");
    await expect(cards).toHaveCount(v.doc.scenes.length);
    // Real keyframes arrive for every shot.
    await expect(page.getByRole("img", { name: /Frame from shot/ })).toHaveCount(v.doc.scenes.length, { timeout: 90_000 });

    await cards.first().getByRole("button", { name: "Revise…" }).click();
    await page.getByRole("textbox", { name: "What should change in shot 1?" }).fill("Hold this shot a little longer.");
    await page.getByRole("button", { name: "Revise shot" }).click();
    await expect(cards.first().getByText(/^Revised:/)).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: "Replan with a note…" }).click();
    await page.getByRole("textbox", { name: "What should change overall?" }).fill("Fewer transitions.");
    await page.getByRole("button", { name: "Replan the storyboard" }).click();
    await expect.poll(async () => jobsOf(await view(request, id), "plan").filter((j) => j.status === "succeeded").length, { timeout: 60_000 }).toBe(2);
    // The replanned storyboard is again held for review, and the screen shows it.
    expect((await view(request, id)).doc.review.status).toBe("pending");
    await expect(page.getByText(/Updated: storyboard planned/)).toBeVisible();

    await page.getByRole("button", { name: "Approve & render a draft" }).click();
    await expect(page.getByRole("heading", { name: "Shot plan" })).toHaveCount(0);
    const after = await view(request, id);
    expect(after.doc.review.status).toBe("approved");
    expect(jobsOf(after, "preview").length).toBe(1);
  });

  test("with a voice, the voiceover waits for approval", async ({ page, request }) => {
    test.setTimeout(180_000);
    await scenario(request, "max");
    const voices = (await (await request.get("/api/voices")).json()).voices as { id: string; kind: string }[];
    const voice = voices.find((x) => x.kind === "local");
    test.skip(!voice, "no local TTS voice on this worker");
    const id = await plannedForReview(request, "Shot plan voice", { voiceId: voice!.id });
    const v = await view(request, id);
    expect(v.doc.review).toMatchObject({ status: "pending", next: { voiceId: voice!.id } });
    expect(jobsOf(v, "tts")).toHaveLength(0);

    await page.goto(`/projects/${id}`);
    await page.getByRole("button", { name: "Approve & record voiceover" }).click();
    await expect(page.getByRole("heading", { name: "Shot plan" })).toHaveCount(0);
    await expect.poll(async () => jobsOf(await view(request, id), "tts").length).toBe(1);
  });

});
