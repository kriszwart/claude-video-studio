import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiUpload, createProject, FIX, renderAndWait } from "./helpers";

/**
 * Phase 4 OpenTimelineIO export, validated with the reference OpenTimelineIO library
 * (python3 -m pip install opentimelineio); skipped when it is not installed.
 */
const hasOtio = (() => {
  try {
    execFileSync("python3", ["-c", "import opentimelineio"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("a rendered version packages as .otioz that OpenTimelineIO reads with media linked", async ({ page, request }) => {
  test.skip(!hasOtio, "OpenTimelineIO (python) is not installed");
  test.setTimeout(600_000);
  const music = await apiUpload(request, join(FIX, "music-launch-bed.m4a"), "audio/mp4");
  const created = await createProject(request, { templateId: "motion-reel", title: "OTIO export", inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave", music } });
  const id = created.project.id;
  const view = async () => (await request.get(`/api/projects/${id}`)).json();
  let v = await view();
  await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: [{ op: "setSceneScript", sceneId: v.doc.scenes[0].id, narration: "Focus wins." }, { op: "setSceneScript", sceneId: v.doc.scenes[1].id, narration: "Plan less and ship more." }] } });
  const { job: tts } = await (await request.post(`/api/projects/${id}/narration`, { data: { voiceId: "espeak:en-us", rate: 1, fit: "keep" } })).json();
  await expect.poll(async () => (await (await request.get(`/api/jobs/${tts.id}`)).json()).job.status, { timeout: 120_000 }).toBe("succeeded");
  await renderAndWait(request, id, "preview");
  v = await view();

  // UI: the Export tab packages it and offers the download.
  await page.goto(`/projects/${id}`);
  await page.getByRole("tab", { name: "export" }).click();
  await page.getByRole("button", { name: "Package .otioz" }).click();
  const link = page.getByTestId("otio-download");
  await expect(link).toBeVisible({ timeout: 120_000 });
  const res = await request.get((await link.getAttribute("href"))!);
  expect(res.status()).toBe(200);
  const dir = mkdtempSync(join(tmpdir(), "otioz-"));
  const file = join(dir, "export.otioz");
  writeFileSync(file, await res.body());

  const summary = JSON.parse(
    execFileSync("python3", [
      "-c",
      `
import json, os, sys, zipfile, opentimelineio as otio
def plain(x):
    if hasattr(x, "items"): return {k: plain(v) for k, v in x.items()}
    if type(x).__name__ in ("AnyVector", "list", "tuple"): return [plain(v) for v in x]
    return x
path = sys.argv[1]
out = os.path.join(os.path.dirname(path), "x")
os.makedirs(out, exist_ok=True)
tl = otio.adapters.read_from_file(path, extract_to_directory=out)
names = zipfile.ZipFile(path).namelist()
tracks = [{"name": t.name, "kind": t.kind, "clips": [c.name for c in t.find_clips()], "dur": t.duration().to_seconds()} for t in tl.tracks]
missing = [c.media_reference.target_url for c in tl.find_clips() if not os.path.exists(os.path.join(out, c.media_reference.target_url))]
print(json.dumps({"tracks": tracks, "duration": tl.duration().to_seconds(), "markers": len(tl.tracks.markers), "files": names, "missing": missing, "meta": plain(tl.metadata["video_studio"]), "first": plain(tl.tracks[0].find_clips()[0].metadata["video_studio"])}))
`,
      file,
    ]).toString(),
  );
  const [program, ...rest] = summary.tracks;
  expect(program).toMatchObject({ name: "Program", kind: "Video" });
  expect(program.clips).toEqual(v.doc.scenes.map((s: { purpose: string }, i: number) => `${i + 1}. ${s.purpose}`));
  const render = v.exports.find((e: { revisionId: string }) => e.revisionId === v.revision.id);
  expect(Math.abs(summary.duration - render.durationSec)).toBeLessThan(0.1);
  const voice = rest.find((t: { name: string }) => t.name === "Voiceover");
  expect(voice.kind).toBe("Audio");
  expect(voice.clips).toHaveLength(2);
  expect(rest.find((t: { name: string }) => t.name === "Music")?.clips).toHaveLength(1);
  expect(summary.missing).toEqual([]);
  expect(summary.files).toEqual(expect.arrayContaining(["content.otio", "version.txt", "media/program.mp4"]));
  expect(summary.meta).toMatchObject({ projectId: id, revisionId: v.revision.id, fps: 30 });
  expect(summary.first).toMatchObject({ sceneId: v.doc.scenes[0].id, narration: "Focus wins." });
});
