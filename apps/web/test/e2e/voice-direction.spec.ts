import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";

/** Phase 2 per-scene voice direction, with a real local voice (Pico) on the worker. */
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const STATE = process.env.STUDIO_CLAUDE_SDK_DOUBLE_STATE ?? join(ROOT, "data", "fake-claude.json");
const view = async (request: APIRequestContext, id: string) => (await request.get(`/api/projects/${id}`)).json();
const LINE = "Focus time is the part of your week that meetings cannot touch.";

async function narrate(request: APIRequestContext, id: string) {
  const { job } = await (await request.post(`/api/projects/${id}/narration`, { data: { voiceId: "pico:en-US", rate: 1, fit: "extend" } })).json();
  await expect.poll(async () => (await (await request.get(`/api/jobs/${job.id}`)).json()).job.status, { timeout: 90_000 }).toBe("succeeded");
  return (await (await request.get(`/api/jobs/${job.id}`)).json()).job.result as { scenes: { sceneId: string; reused: boolean; durationSec: number }[] };
}

test.describe.serial("Voice direction", () => {
  test.afterAll(() => writeFileSync(STATE, JSON.stringify({ scenario: "signed_out" })));

  test("pace changes the recorded line; ignored parts never re-record; the Scene tab edits it", async ({ page, request }) => {
    test.setTimeout(240_000);
    const voices = (await (await request.get("/api/voices")).json()).voices as { id: string }[];
    test.skip(!voices.some((v) => v.id === "pico:en-US"), "Pico is not available on this worker");
    const created = await (await request.post("/api/projects", { data: { templateId: "motion-reel", title: "Voice direction", inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave" } } })).json();
    const id = created.project.id as string;
    let v = await view(request, id);
    const [s1, s2] = v.doc.scenes;
    const op = async (ops: unknown[]) => {
      const cur = await view(request, id);
      const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: cur.revision.id, ops } });
      expect(r.status()).toBe(200);
    };
    await op([
      { op: "setSceneScript", sceneId: s1.id, narration: LINE },
      { op: "setSceneScript", sceneId: s2.id, narration: LINE },
      { op: "setSceneVoiceDirection", sceneId: s2.id, direction: { pace: "slower", energy: "neutral", note: "" } },
    ]);
    const first = await narrate(request, id);
    const d = (sid: string) => first.scenes.find((x) => x.sceneId === sid)!.durationSec;
    // Same words, one scene slower: that line is measurably longer (Pico has no rate flag; tempo is applied).
    expect(d(s2.id) / d(s1.id)).toBeGreaterThan(1.07);

    // A note is ignored by built-in voices, so changing it must not re-record anything.
    await op([{ op: "setSceneVoiceDirection", sceneId: s1.id, direction: { pace: "normal", energy: "lively", note: "stress focus" } }]);
    expect((await narrate(request, id)).scenes.every((x) => x.reused)).toBe(true);

    // Pace is used: changing it re-records exactly that line.
    await op([{ op: "setSceneVoiceDirection", sceneId: s1.id, direction: { pace: "faster", energy: "neutral", note: "" } }]);
    const third = await narrate(request, id);
    expect(third.scenes.find((x) => x.sceneId === s1.id)!.reused).toBe(false);
    expect(third.scenes.find((x) => x.sceneId === s2.id)!.reused).toBe(true);

    // The Scene tab shows the control for narrated scenes and saves changes.
    await page.goto(`/projects/${id}`);
    await page.getByRole("tab", { name: "scene" }).click();
    const pace = page.getByRole("radiogroup", { name: "Scene delivery: pace" });
    await expect(pace.getByRole("radio", { name: "Faster" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Built-in voices follow pace only.")).toBeVisible();
    await pace.getByRole("radio", { name: "Slower" }).click();
    await expect.poll(async () => (await view(request, id)).doc.scenes[0].script.direction?.pace).toBe("slower");
    await page.getByRole("tab", { name: "audio" }).click();
    await expect(page.getByTestId("direction-note")).toContainText("2 lines have delivery direction");
  });

  test("the scriptwriter's direction reaches the planned scenes", async ({ request }) => {
    test.setTimeout(120_000);
    writeFileSync(STATE, JSON.stringify({ scenario: "max" }));
    expect((await request.post("/api/settings/claude")).status()).toBe(200);
    const created = await (await request.post("/api/projects", { data: { templateId: "motion-reel", title: "Direction via script", inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave" }, script: { style: "professor", narrated: true } } })).json();
    const id = created.project.id as string;
    await expect.poll(async () => (await view(request, id)).doc.script?.status, { timeout: 60_000 }).toBe("draft");
    const v = await view(request, id);
    expect(v.doc.script.beats[0].direction).toEqual({ pace: "slower", energy: "calm", note: "let the first line land" });
    // Neutral directions are not stored.
    expect(v.doc.script.beats[1].direction).toBeUndefined();
    const a = await (await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: [{ op: "setScriptStatus", status: "approved" }] } })).json();
    await request.post(`/api/projects/${id}/plan`, { data: { baseRevisionId: a.revisionId, review: true } });
    await expect.poll(async () => (await view(request, id)).jobs.find((j: { type: string }) => j.type === "plan")?.status, { timeout: 60_000 }).toBe("succeeded");
    const planned = await view(request, id);
    expect(planned.doc.scenes[0].script.direction).toEqual({ pace: "slower", energy: "calm", note: "let the first line land" });
    expect(planned.doc.scenes[1].script.direction).toBeUndefined();
  });
});
