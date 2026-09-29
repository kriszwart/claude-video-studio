import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { apiUpload, createProject, downloadAndProbe, FIX, frameAt, renderAndWait, waitForJobs } from "./helpers";

type Beat = { id: string; cue: { phrase: string; occurrence: number; sourceStartSec?: number }; status: string; outputFrame?: number; anchor: { x: number; y: number } | null };

async function ops(request: APIRequestContext, id: string, list: unknown[]) {
  const v = await (await request.get(`/api/projects/${id}`)).json();
  const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: list } });
  expect(r.status(), await r.text()).toBe(200);
  return r.json();
}

/** Speech onsets (end of each silence) measured on a file's audio. */
function speechOnsets(file: string): number[] {
  const out = execFileSync("sh", ["-c", `ffmpeg -hide_banner -i '${file}' -vn -af silencedetect=n=-38dB:d=0.1 -f null - 2>&1 | grep -o 'silence_end: [0-9.]*' || true`]).toString();
  return [...out.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
}

test.describe.serial("M3 talking head", () => {
  let recording = "";
  let srt = "";
  let logoA = "";
  let logoB = "";
  let shot = "";
  let projectId = "";

  test.beforeAll(async ({ request }) => {
    recording = await apiUpload(request, join(FIX, "talking-head-avocado.mp4"), "video/mp4");
    srt = await apiUpload(request, join(FIX, "talking-head-avocado.srt"), "application/x-subrip");
    logoA = await apiUpload(request, join(FIX, "logo-tidewave.png"), "image/png");
    logoB = await apiUpload(request, join(FIX, "logo-lumen.png"), "image/png");
    shot = await apiUpload(request, join(FIX, "tidewave-dashboard.png"), "image/png");
  });

  test("A11/A17: transcript-first cuts keep speech, captions and phrase-timed labels in sync", async ({ page, request }) => {
    test.setTimeout(20 * 60_000);
    const t0 = Date.now();
    const created = await createProject(request, { templateId: "presenter-intro", title: "E2E presenter intro", inputs: { recording, transcript: srt, visuals: [shot], topic: "Avocado toast" } });
    projectId = created.project.id;
    const tr = await waitForJobs(request, projectId, "transcribe", t0);
    expect(tr.job.status, JSON.stringify(tr.job.error)).toBe("succeeded");
    expect(tr.job.result.provider).toBe("subtitle-import");
    expect(tr.view.doc.scenes.length).toBe(5);

    // Beat sheet: Tool A logo on the left, Tool B on the right, emphasis on the SECOND "avocado toast".
    const occ = await (await request.get(`/api/projects/${projectId}/transcript?phrase=avocado%20toast`)).json();
    expect(occ.occurrences.length).toBe(2);
    const beat = (id: string, phrase: string, extra: Record<string, unknown>) => ({ id, cue: { phrase, occurrence: 1 }, message: "", text: "", durationFrames: 75, ...extra });
    let res = await ops(request, projectId, [
      {
        op: "setBeats",
        beats: [
          ...tr.view.doc.beats,
          beat("beatToolA", "Tool A", { visualAction: "logo", assetId: logoA, text: "Tool A", anchor: { x: 0.22, y: 0.3 }, anchorLocked: true }),
          beat("beatToolB", "Tool B", { visualAction: "logo", assetId: logoB, text: "Tool B", anchor: { x: 0.78, y: 0.3 }, anchorLocked: true }),
          beat("beatBest", "avocado toast", { cue: { phrase: "avocado toast", occurrence: 2 }, visualAction: "emphasis", text: "The best avocado toast", anchor: { x: 0.5, y: 0.66 } }),
          beat("beatMissing", "Tool C", { visualAction: "label", text: "Tool C" }),
        ],
      },
    ]);
    const find = (d: { beats: Beat[] }, id: string) => d.beats.find((b) => b.id === id)!;
    const before = find(res.doc, "beatBest");
    expect(before.status).toBe("mapped");
    expect(before.cue.sourceStartSec).toBeGreaterThan(9.7);
    expect(find(res.doc, "beatMissing").status).toBe("missing");
    const toolABefore = find(res.doc, "beatToolA").outputFrame!;

    // Propose cuts: the false start + filler is a reviewable "mistake"; pauses are "silence".
    const t1 = Date.now();
    expect((await request.post(`/api/projects/${projectId}/cuts`, { data: {} })).status()).toBe(202);
    const cutsJob = await waitForJobs(request, projectId, "propose_cuts", t1);
    expect(cutsJob.job.status, JSON.stringify(cutsJob.job.error)).toBe("succeeded");
    const proposed = cutsJob.view.doc.program.proposedCuts as { id: string; kind: string; sourceInSec: number; sourceOutSec: number; context: string }[];
    const retake = proposed.find((c) => c.kind === "mistake")!;
    expect(retake.context).toContain("avocado toast");
    expect(proposed.filter((c) => c.kind === "silence").length).toBeGreaterThanOrEqual(3);
    // Nothing was applied without review.
    expect(cutsJob.view.doc.program.edl.length).toBe(1);

    res = await ops(request, projectId, [{ op: "acceptCuts", cutIds: proposed.map((c) => c.id) }]);
    const removed = proposed.reduce((a, c) => a + (c.sourceOutSec - c.sourceInSec), 0);
    const after = find(res.doc, "beatBest");
    expect(after.status).toBe("mapped");
    expect(after.cue.sourceStartSec).toBeCloseTo(before.cue.sourceStartSec!, 3);
    // The label moved earlier by exactly the removed material before it.
    const removedBefore = proposed.filter((c) => c.sourceOutSec <= before.cue.sourceStartSec!).reduce((a, c) => a + (c.sourceOutSec - c.sourceInSec), 0);
    expect(Math.abs(before.outputFrame! - after.outputFrame! - removedBefore * 30)).toBeLessThanOrEqual(proposed.length + 1);
    expect(find(res.doc, "beatToolA").outputFrame!).toBeLessThan(toolABefore);

    const r = await renderAndWait(request, projectId, "preview");
    expect(r.job.status, JSON.stringify(r.job.error)).toBe("succeeded");
    const exp = r.view.exports.find((e: { jobId: string }) => e.jobId === r.job.id);
    expect(Math.abs(exp.durationSec - (38.21 - removed))).toBeLessThan(0.2);
    const { file } = await downloadAndProbe(page, exp.downloadUrl, "a11-presenter-cut.mp4");

    // Speech/caption sync: every transcript segment's first caption starts at a measured speech onset.
    const tx = await (await request.get(`/api/projects/${projectId}/transcript`)).json();
    const onsets = speechOnsets(file);
    const kept = (tx.segments as { outputSec: number | null; text: string }[]).filter((s) => s.outputSec !== null);
    // Exactly the false start and the filler are gone; every other utterance is kept.
    const gone = (tx.segments as { outputSec: number | null; text: string }[]).filter((s) => s.outputSec === null).map((s) => s.text);
    expect(gone).toEqual(["Today I will show you how to make avocado toast.", "Um, um."]);
    expect(kept.length).toBe(7);
    for (const s of kept) {
      const nearest = Math.min(...onsets.map((o) => Math.abs(o - s.outputSec!)), s.outputSec! < 0.6 ? s.outputSec! : 99);
      expect(nearest, `speech onset near "${s.text}" at ${s.outputSec}`).toBeLessThan(0.35);
    }
    const aT = find(res.doc, "beatToolA").outputFrame! / 30;
    const bT = find(res.doc, "beatToolB").outputFrame! / 30;
    frameAt(file, aT + 0.8, "a17-tool-a.png");
    frameAt(file, bT + 0.8, "a17-tool-b.png");
    frameAt(file, after.outputFrame! / 30 + 1, "a17-best-toast.png");
    frameAt(file, 1.0, "a11-open.png");

    // A transcript correction that removes the phrase flags the beat instead of guessing.
    const seg4 = (tx.segments as { id: string; text: string }[]).find((s) => s.text.startsWith("Today I will show you how to make the best"))!;
    res = await ops(request, projectId, [{ op: "correctTranscript", segmentId: seg4.id, text: "Today I will show you the best breakfast." }]);
    expect(find(res.doc, "beatBest").status).toBe("missing");
    expect(res.doc.captions.cues.some((c: { text: string }) => c.text.includes("breakfast"))).toBe(true);
    // Restore the original wording: the beat maps again.
    res = await ops(request, projectId, [{ op: "correctTranscript", segmentId: seg4.id, text: "Today I will show you how to make the best avocado toast." }]);
    expect(find(res.doc, "beatBest").status).toBe("mapped");
  });

  test("A18: one recording, three independent styles sharing source and transcript", async ({ page, request }) => {
    test.setTimeout(40 * 60_000);
    const src = await (await request.get(`/api/projects/${projectId}`)).json();
    const transcribesBefore = src.jobs.filter((j: { type: string }) => j.type === "transcribe").length;
    const ids: Record<string, string> = {};
    for (const style of ["whiteboard", "course", "social"] as const) {
      const r = await request.post(`/api/projects/${projectId}/variants`, { data: { style } });
      expect(r.status(), await r.text()).toBe(201);
      const v = await r.json();
      expect(v.sharedTranscriptId).toBe(src.doc.program.transcriptId);
      expect(v.doc.program.sourceAssetId).toBe(recording);
      expect(v.doc.program.transcriptId).toBe(src.doc.program.transcriptId);
      // Same kept material (the accepted cuts carry over), style-specific scenes.
      expect(v.doc.program.edl).toEqual(src.doc.program.edl);
      ids[style] = v.project.id;
    }
    const wb = await (await request.get(`/api/projects/${ids.whiteboard}`)).json();
    expect(wb.doc.scenes.some((s: { layout: string }) => s.layout === "whiteboard")).toBe(true);
    const social = await (await request.get(`/api/projects/${ids.social}`)).json();
    expect(social.doc.format.aspect).toBe("9:16");
    // No re-transcription happened anywhere.
    const after = await (await request.get(`/api/projects/${projectId}`)).json();
    expect(after.jobs.filter((j: { type: string }) => j.type === "transcribe").length).toBe(transcribesBefore);
    for (const id of Object.values(ids)) expect(((await (await request.get(`/api/projects/${id}`)).json()).jobs as { type: string }[]).some((j) => j.type === "transcribe")).toBe(false);

    // Sibling isolation: editing the course headline leaves whiteboard and the original untouched.
    const course = await (await request.get(`/api/projects/${ids.course}`)).json();
    const scene = course.doc.scenes[1];
    const head = scene.layers.find((l: { role?: string }) => l.role === "headline");
    await ops(request, ids.course, [{ op: "updateLayerText", sceneId: scene.id, layerId: head.id, text: "Toast the sourdough first" }]);
    const wb2 = await (await request.get(`/api/projects/${ids.whiteboard}`)).json();
    expect(wb2.revision.id).toBe(wb.revision.id);
    const orig2 = await (await request.get(`/api/projects/${projectId}`)).json();
    expect(orig2.revision.id).toBe(after.revision.id);

    for (const [style, id] of Object.entries(ids)) {
      const r = await renderAndWait(request, id, "preview");
      expect(r.job.status, `${style}: ${JSON.stringify(r.job.error)}`).toBe("succeeded");
      const exp = r.view.exports.find((e: { jobId: string }) => e.jobId === r.job.id);
      const { file } = await downloadAndProbe(page, exp.downloadUrl, `a18-${style}.mp4`);
      expect(exp.loudness.lufs).toBeGreaterThan(-20);
      const scenes = r.view.doc.scenes as { durationFrames: number }[];
      let t = 0;
      scenes.forEach((s, i) => {
        frameAt(file, t + Math.min(2.2, s.durationFrames / 60), `a18-${style}-${i + 1}.png`);
        t += s.durationFrames / 30;
      });
    }
  });
});
