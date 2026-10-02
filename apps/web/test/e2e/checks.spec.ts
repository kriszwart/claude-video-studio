import { expect, test, type APIRequestContext } from "@playwright/test";
import { createProject } from "./helpers";

/**
 * Measured checks on the rendered draft: a seeded one-frame flash is found by the frame scan, and
 * a video marked "made to loop" whose last frame doesn't match its first gets a loop-seam issue.
 */
type Scene = { id: string; layers: { id: string }[] };
const view = async (request: APIRequestContext, id: string) => (await request.get(`/api/projects/${id}`)).json();
const ops = async (request: APIRequestContext, id: string, o: unknown[]) => {
  const v = await view(request, id);
  const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: o } });
  expect(r.status(), await r.text()).toBe(200);
};
async function review(request: APIRequestContext, id: string) {
  const v = await view(request, id);
  const job = (await (await request.post(`/api/projects/${id}/quality`, { data: { revisionId: v.revision.id, maxRepairPasses: 0 } })).json()).job;
  await expect.poll(async () => (await (await request.get(`/api/jobs/${job.id}`)).json()).job.status, { timeout: 8 * 60_000, intervals: [2000] }).toBe("succeeded");
  return (await (await request.get(`/api/projects/${id}/quality`)).json()).reports[0];
}

test("frame scan finds a one-frame flash; a loop whose ends don't match is flagged", async ({ page, request }) => {
  test.setTimeout(15 * 60_000);
  const { project } = await createProject(request, { templateId: "motion-reel", title: "Checks: flash and loop", inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave" } });
  const id = project.id;
  const first = (await view(request, id)).doc.scenes[0] as Scene;
  // Seed: an empty grey opener, one frame of white, then the same grey again — a one-frame flash.
  await ops(request, id, [
    ...first.layers.map((l) => ({ op: "setLayerHidden", sceneId: first.id, layerId: l.id, hidden: true })),
    { op: "setSceneBackground", sceneId: first.id, background: { type: "color", color: "#333a44" } },
    { op: "setSceneDuration", sceneId: first.id, durationFrames: 30 },
    { op: "duplicateScene", sceneId: first.id, newSceneId: "scn_flash" },
    { op: "duplicateScene", sceneId: first.id, newSceneId: "scn_after" },
    { op: "moveScene", sceneId: "scn_flash", toIndex: 1 },
    { op: "moveScene", sceneId: "scn_after", toIndex: 2 },
    { op: "setSceneDuration", sceneId: "scn_flash", durationFrames: 1 },
    { op: "setSceneBackground", sceneId: "scn_flash", background: { type: "color", color: "#ffffff" } },
    { op: "setSceneTransition", sceneId: "scn_flash", transition: { type: "cut", durationFrames: 0 } },
    { op: "setSceneTransition", sceneId: "scn_after", transition: { type: "cut", durationFrames: 0 } },
  ]);

  // The owner marks it as a loop from the Export tab.
  await page.goto(`/projects/${id}`);
  await page.getByRole("tab", { name: /export/i }).click();
  await page.getByRole("checkbox", { name: /Made to loop/ }).click();
  await expect.poll(async () => (await view(request, id)).doc.loop).toBe(true);

  const r = await review(request, id);
  const issues = r.report.unresolved as { code: string; sceneId?: string; atSec?: number }[];
  const flash = issues.filter((i) => i.code === "frame_flash");
  expect(flash).toHaveLength(1);
  expect(flash[0]!.atSec).toBeCloseTo(30 / 30, 1);
  expect(flash[0]!.sceneId).toBe("scn_flash");
  expect(issues.filter((i) => i.code === "frame_jump")).toEqual([]);
  expect(issues.some((i) => i.code === "loop_seam")).toBe(true);
  expect(r.verdict).toBe("needs_review");

  // Fixed: no flash, not a loop → neither issue.
  await ops(request, id, [{ op: "deleteScene", sceneId: "scn_flash" }, { op: "setLoop", loop: false }]);
  const r2 = await review(request, id);
  expect((r2.report.unresolved as { code: string }[]).filter((i) => /^frame_|loop_seam/.test(i.code))).toEqual([]);
});
