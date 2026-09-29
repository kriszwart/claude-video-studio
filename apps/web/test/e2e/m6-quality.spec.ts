import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ART, createProject, downloadAndProbe } from "./helpers";

type Layer = { id: string; kind: string; role?: string; text?: string };
type Scene = { id: string; purpose: string; durationFrames: number; locked: boolean; layers: Layer[] };

/** A22: seeded overflow and cue error are detected and repaired; an unrepairable one stops within the bound. */
test("A22: bounded review–repair", async ({ page, request }) => {
  test.setTimeout(20 * 60_000);
  const created = await createProject(request, { templateId: "motion-reel", title: "QA seeded problems", inputs: { hook: "Focus wins", headline: "Plan less. Ship more.", brandName: "Lumen Notes", points: ["Deep work", "Clear weeks"], cta: "lumen.example" } });
  const id = created.project.id;
  let v = await (await request.get(`/api/projects/${id}`)).json();
  const scenes = v.doc.scenes as Scene[];
  const s1 = scenes[0]!;
  const t1 = s1.layers.find((l) => l.kind === "text")!;
  const s2 = scenes[1]!;
  const t2 = s2.layers.find((l) => l.kind === "text" && l.role === "kicker") ?? s2.layers.find((l) => l.kind === "text")!;
  const LONG = "Plan every week in minutes with a calm, focused workspace that keeps your whole team aligned on the few things that matter most, every single day, without extra meetings, status reports, reminders, or long threads that nobody reads until the end of the quarter";
  // Seed: (1) text that can't fit its slot, (2) a caption running 1.5 s past its scene, (3) the same overflow in a locked scene.
  const seed = await request.post(`/api/projects/${id}/operations`, {
    data: {
      baseRevisionId: v.revision.id,
      ops: [
        { op: "updateLayerText", sceneId: s1.id, layerId: t1.id, text: `${LONG}. ${LONG}` },
        { op: "setCaptions", captions: { enabled: true } },
        { op: "setCaptionCues", cues: [{ id: "cue_seeded", text: "This caption was timed past its scene", anchor: { type: "scene", sceneId: s1.id, offsetFrames: 0 }, startFrame: 10, endFrame: s1.durationFrames + 45, timing: "manual" }] },
        { op: "updateLayerText", sceneId: s2.id, layerId: t2.id, text: `${LONG}. ${LONG}` },
        { op: "setSceneLock", sceneId: s2.id, locked: true },
      ],
    },
  });
  expect(seed.status(), await seed.text()).toBe(200);
  v = await (await request.get(`/api/projects/${id}`)).json();
  const seededRevision = v.revision.id;

  // Run from the editor's Export tab.
  await page.goto(`/projects/${id}`);
  await page.getByRole("tab", { name: /export/i }).click();
  await page.getByRole("button", { name: "Review & repair draft" }).click();
  const report = page.getByTestId("quality-report");
  await expect(report).toBeVisible({ timeout: 5 * 60_000 });
  await expect(report).toContainText(/Needs review/, { timeout: 60_000 });

  const r = (await (await request.get(`/api/projects/${id}/quality`)).json()).reports[0];
  writeFileSync(join(ART, "m6-quality-report.json"), JSON.stringify(r, null, 2));
  expect(r.verdict).toBe("needs_review");
  const passes = r.report.passes as { issues: { code: string; sceneId?: string; cueId?: string; repairable: boolean }[]; repairs: { op: string }[]; evidence: unknown[] }[];
  // Bound: at most 1 + maxRepairPasses review passes; the loop stopped on its own.
  expect(passes.length).toBeLessThanOrEqual(1 + r.report.maxRepairPasses);
  expect(["unchanged repeated failure", "no automatic repair available", "repair pass limit reached"]).toContain(r.report.stopReason);
  // Detected in the first pass.
  const first = passes[0]!.issues;
  expect(first.some((i) => /text_(overflow|too_small)/.test(i.code) && i.sceneId === s1.id && i.repairable)).toBe(true);
  expect(first.some((i) => i.code === "cue_overruns_scene" && i.cueId === "cue_seeded")).toBe(true);
  expect(first.some((i) => /text_(overflow|too_small)/.test(i.code) && i.sceneId === s2.id && !i.repairable)).toBe(true);
  expect(passes[0]!.repairs.map((x) => x.op)).toEqual(expect.arrayContaining(["setLayerBox", "setCaptionCues"]));
  expect(passes[0]!.evidence.length).toBeGreaterThan(0);
  // Repaired: the unlocked overflow and the cue error are gone; the locked scene remains, visibly.
  const last = passes.at(-1)!.issues;
  expect(last.some((i) => i.sceneId === s1.id)).toBe(false);
  expect(last.some((i) => i.code === "cue_overruns_scene")).toBe(false);
  expect(r.report.unresolved.some((i: { sceneId?: string }) => i.sceneId === s2.id)).toBe(true);

  // Repairs are normal, attributed, undoable revisions; text was never rewritten; the locked scene is untouched.
  const after = await (await request.get(`/api/projects/${id}`)).json();
  expect(after.revision.id).not.toBe(seededRevision);
  const a1 = after.doc.scenes.find((s: Scene) => s.id === s1.id);
  expect(a1.layers.find((l: Layer) => l.id === t1.id).text).toBe(`${LONG}. ${LONG}`);
  expect(a1.layers.find((l: Layer & { box?: unknown }) => l.id === t1.id).box).toBeTruthy();
  expect(after.doc.captions.cues[0].endFrame).toBeLessThanOrEqual(a1.durationFrames);
  expect(after.doc.scenes.find((s: Scene) => s.id === s2.id)).toEqual(v.doc.scenes.find((s: Scene) => s.id === s2.id));
  const revs = await (await request.get(`/api/projects/${id}/revisions`)).json();
  expect(JSON.stringify(revs)).toMatch(/quality repair \(pass 1\)/);

  // The retained draft is a real, playable file linked from the report.
  const exp = after.exports.find((e: { jobId: string }) => e.jobId === r.jobId);
  const { probe } = await downloadAndProbe(page, exp.downloadUrl, "m6-quality-draft.mp4");
  expect(probe.streams.map((s: { codec_name: string }) => s.codec_name)).toEqual(["h264", "aac"]);
  await page.screenshot({ path: join(ART, "m6-quality-panel.png"), fullPage: true });
});
