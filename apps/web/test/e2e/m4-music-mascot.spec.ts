import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { apiUpload, createProject, downloadAndProbe, FIX, frameAt, renderAndWait, waitForJobs } from "./helpers";

/** Mono 8 kHz PCM of [start, start+dur) seconds. */
function pcm(file: string, start: number, dur: number): Float32Array {
  const b = execFileSync("ffmpeg", ["-v", "error", "-ss", String(start), "-i", file, "-t", String(dur), "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"], { maxBuffer: 64 * 1024 * 1024 });
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
}
/** Best normalised cross-correlation within ±lagSec, and the lag where it occurs. */
function xcorr(a: Float32Array, b: Float32Array, lagSec = 0.15) {
  const maxLag = Math.round(lagSec * 8000);
  let best = { r: -1, lag: 0 };
  for (let lag = -maxLag; lag <= maxLag; lag += 4) {
    let sab = 0, saa = 0, sbb = 0;
    for (let i = maxLag; i < a.length - maxLag; i++) {
      const x = a[i]!, y = b[i + lag] ?? 0;
      sab += x * y; saa += x * x; sbb += y * y;
    }
    const r = sab / Math.sqrt(saa * sbb || 1);
    if (r > best.r) best = { r, lag: lag / 8000 };
  }
  return best;
}
function luma(file: string, t: number): number {
  // Decode exactly one frame to PNG first, then measure it (seeking + filters can emit extra frames).
  const png = `/tmp/vs-luma-${process.pid}.png`;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", file, "-frames:v", "1", png]);
  const out = execFileSync("sh", ["-c", `ffmpeg -hide_banner -i ${png} -vf signalstats,metadata=print:key=lavfi.signalstats.YAVG -f null - 2>&1 | grep -o 'YAVG=[0-9.]*' | head -1`]).toString();
  return Number(out.split("=")[1]);
}
async function ops(request: APIRequestContext, id: string, list: unknown[]) {
  const v = await (await request.get(`/api/projects/${id}`)).json();
  const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: list } });
  expect(r.status(), await r.text()).toBe(200);
  return r.json();
}

test.describe.serial("M4 music video and mascot story (A12)", () => {
  test("T6: excerpt, section cuts, marker-aligned accents, editable timing", async ({ page, request }) => {
    test.setTimeout(20 * 60_000);
    const song = await apiUpload(request, join(FIX, "music-song.m4a"), "audio/mp4");
    const t0 = Date.now();
    const created = await createProject(request, { templateId: "music-video", title: "E2E music video", inputs: { song, excerptStart: 20, excerptEnd: 70, songTitle: "Night Drive", artist: "Sample Band", motif: "ring", lyrics: "Headlights on the open road\nCity fading into gold\nWe keep driving through the night\nChasing every neon light" } });
    const an = await waitForJobs(request, created.project.id, "analyze_music", t0);
    expect(an.job.status, JSON.stringify(an.job.error)).toBe("succeeded");
    expect(Math.abs(an.job.result.bpm - 120)).toBeLessThan(1);
    const doc = an.view.doc;
    // Sections at 24/40/56 s of the song → cuts at 4/20/36 s of the video; 50 s total.
    const starts: number[] = [];
    let acc = 0;
    for (const s of doc.scenes) { starts.push(acc); acc += s.durationFrames; }
    expect(starts.map((f) => Math.round(f / 3) / 10)).toEqual([0, 4, 20, 36]);
    expect(acc).toBe(1500);
    const sectionMarkers = doc.markers.filter((m: { kind: string }) => m.kind === "section").map((m: { frame: number }) => m.frame);
    // Markers sit within 2 frames of the true section boundaries, and every cut is ON a marker.
    for (const want of [120, 600, 1080]) expect(sectionMarkers.some((f: number) => Math.abs(f - want) <= 2)).toBe(true);
    for (const cut of starts.slice(1)) expect(sectionMarkers).toContain(cut);
    expect(doc.markers.every((m: { verified: boolean }) => !m.verified)).toBe(true);
    expect(doc.captions.cues.length).toBe(4);

    // Manual timing: move a proposed downbeat marker — it becomes the owner's (verified).
    const down = doc.markers.find((m: { kind: string; frame: number }) => m.kind === "downbeat" && m.frame > 300);
    const moved = await ops(request, created.project.id, [{ op: "moveMarker", markerId: down.id, frame: down.frame + 3 }]);
    expect(moved.doc.markers.find((m: { id: string }) => m.id === down.id)).toMatchObject({ frame: down.frame + 3, verified: true });
    await ops(request, created.project.id, [{ op: "moveMarker", markerId: down.id, frame: down.frame }]);

    const r = await renderAndWait(request, created.project.id, "preview");
    expect(r.job.status, JSON.stringify(r.job.error)).toBe("succeeded");
    const exp = r.view.exports.find((e: { jobId: string }) => e.jobId === r.job.id);
    expect(Math.abs(exp.durationSec - 50)).toBeLessThan(0.1);
    const { file } = await downloadAndProbe(page, exp.downloadUrl, "a12-music-video.mp4");
    // The export's audio IS the selected excerpt: video t=10 ≡ song t=30, in phase.
    const c = xcorr(pcm(join(FIX, "music-song.m4a"), 30, 6), pcm(file, 10, 6));
    expect(c.r).toBeGreaterThan(0.9);
    expect(Math.abs(c.lag)).toBeLessThan(0.03);
    // Accents: a section cut flashes; a downbeat is brighter than 0.3 s after it.
    expect(luma(file, 20.03)).toBeGreaterThan(luma(file, 20.6) + 3);
    const db = (doc.markers as { kind: string; frame: number }[]).find((m) => m.kind === "downbeat" && m.frame > 700)!.frame / 30;
    expect(luma(file, db + 0.02)).toBeGreaterThan(luma(file, db + 0.3));
    for (const [i, t] of [1.5, 8, 22, 30, 45].entries()) frameAt(file, t, `a12-mv-${i + 1}.png`);
  });

  test("T2: mascot story with one persistent vector character", async ({ page, request }) => {
    test.setTimeout(20 * 60_000);
    const music = await apiUpload(request, join(FIX, "music-launch-bed.m4a"), "audio/mp4");
    const logo = await apiUpload(request, join(FIX, "logo-tidewave.png"), "image/png");
    const created = await createProject(request, { templateId: "mascot-story", title: "E2E mascot", inputs: { characterName: "Pip", species: "robot", color: "#22c55e", theme: "From garage to galaxy", eras: ["The garage", "The city", "The moon"], transformation: "Pip becomes a star pilot", finale: "Build yours", logo, music }, durationSec: 30 });
    const id = created.project.id;
    const view = await (await request.get(`/api/projects/${id}`)).json();
    expect(view.doc.characters[0]).toMatchObject({ name: "Pip", species: "robot", locked: true });
    // Background edit on an era never replaces the locked character.
    const era = view.doc.scenes[2];
    const edited = await ops(request, id, [{ op: "varyScene", sceneId: era.id, variant: 7 }]);
    expect(edited.doc.characters).toEqual(view.doc.characters);
    const r = await renderAndWait(request, id, "preview");
    expect(r.job.status, JSON.stringify(r.job.error)).toBe("succeeded");
    const exp = r.view.exports.find((e: { jobId: string }) => e.jobId === r.job.id);
    const { file } = await downloadAndProbe(page, exp.downloadUrl, "a12-mascot.mp4");
    let t = 0;
    for (const [i, s] of (r.view.doc.scenes as { durationFrames: number; transitionIn: { durationFrames: number } }[]).entries()) {
      frameAt(file, t + Math.min(2.5, s.durationFrames / 60), `a12-mascot-${i + 1}.png`);
      const next = r.view.doc.scenes[i + 1];
      t += s.durationFrames / 30 - (next ? next.transitionIn.durationFrames / 30 : 0);
    }
  });
});
