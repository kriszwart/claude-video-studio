import { execFileSync } from "node:child_process";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { computeTimeline, type ProjectDocument } from "@vs/domain";
import { createProject, downloadAndProbe, frameAt, renderAndWait } from "./helpers";

/**
 * Shader transitions in a real render: liquid, lens, grain and morph between scenes of solid,
 * distinct colours, so each frame can be read. Mid-transition the frame shows what each one
 * promises (front, lens, dissolve, shape); after it, the next scene is clean (no filter, mask or
 * light left behind); and the same revision renders the same frames again.
 */
const view = async (request: APIRequestContext, id: string) => (await request.get(`/api/projects/${id}`)).json();
const ops = async (request: APIRequestContext, id: string, o: unknown[]) => {
  const v = await view(request, id);
  const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: o } });
  expect(r.status(), await r.text()).toBe(200);
};

type RGB = [number, number, number];
const W = 96, H = 54;
/** A frame as a 96×54 RGB grid. */
const grid = (f: string) => execFileSync("ffmpeg", ["-v", "error", "-i", f, "-vf", `scale=${W}:${H}:flags=area,format=rgb24`, "-f", "rawvideo", "-"]);
/** Mean colour of a region (fractions of the frame). */
const at = (g: Buffer, x0: number, y0: number, x1: number, y1: number): RGB => {
  const s: RGB = [0, 0, 0];
  let n = 0;
  for (let y = Math.floor(y0 * H); y < Math.ceil(y1 * H); y++)
    for (let x = Math.floor(x0 * W); x < Math.ceil(x1 * W); x++) {
      const i = (y * W + x) * 3;
      s[0] += g[i]!; s[1] += g[i + 1]!; s[2] += g[i + 2]!; n++;
    }
  return s.map((v) => v / n) as RGB;
};
const dist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const diff = (a: Buffer, b: Buffer) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
};

// Far from every brand colour (indigo, navy, orange), so a transition's brand light never passes for a scene.
const COLORS = ["#c8323c", "#2a6fdb", "#1fa35b", "#d8d8d8", "#18a8a0"];
const TRANSITIONS = ["liquid", "lens", "grain", "morph"] as const;
const FRAMES = 20;

test("shader transitions: each does what it says, leaves nothing behind and repeats", async ({ page, request }) => {
  test.setTimeout(30 * 60_000);
  const { project } = await createProject(request, { templateId: "motion-reel", title: "Shader transitions", inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave" } });
  const id = project.id;
  let doc = (await view(request, id)).doc as ProjectDocument;
  for (let k = doc.scenes.length; k < COLORS.length; k++) await ops(request, id, [{ op: "duplicateScene", sceneId: doc.scenes[0]!.id, newSceneId: `scn_tr${k}` }]);
  doc = (await view(request, id)).doc;
  await ops(
    request,
    id,
    doc.scenes.slice(0, COLORS.length).flatMap((s, i) => [
      ...s.layers.map((l) => ({ op: "setLayerHidden", sceneId: s.id, layerId: l.id, hidden: true })),
      { op: "setSceneBackground", sceneId: s.id, background: { type: "color", color: COLORS[i] } },
      { op: "setSceneDuration", sceneId: s.id, durationFrames: 60 },
      ...(i > 0 ? [{ op: "setSceneTransition", sceneId: s.id, transition: { type: TRANSITIONS[i - 1], durationFrames: FRAMES } }] : []),
    ]),
  );
  // Only the five coloured scenes.
  doc = (await view(request, id)).doc;
  for (const s of doc.scenes.slice(COLORS.length)) await ops(request, id, [{ op: "deleteScene", sceneId: s.id }]);
  doc = (await view(request, id)).doc;
  expect(doc.scenes.map((s) => s.transitionIn.type)).toEqual(["cut", ...TRANSITIONS]);
  const tl = computeTimeline(doc);
  const fps = doc.format.fps;

  const render = async (name: string) => {
    const { job, view: after } = await renderAndWait(request, id, "preview");
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    const exp = after.exports.find((e: { jobId: string }) => e.jobId === job.id) ?? after.exports.find((e: { kind: string }) => e.kind === "preview");
    return (await downloadAndProbe(page, exp.downloadUrl, `${name}.mp4`)).file;
  };
  const file = await render("shader-transitions");
  // Output frame `k` of transition `i` (into scene i + 1). Seeking returns the first frame at or
  // after the time, so aim a fifth of a frame early to land on exactly frame k.
  const frame = (f: string, i: number, k: number, tag: string) => grid(frameAt(f, (tl.scenes[i + 1]!.start + k - 0.2) / fps, `tr-${TRANSITIONS[i]}-${tag}.png`));

  for (const [i, type] of TRANSITIONS.entries()) {
    // References: each scene clean, away from the transition.
    const refOut = frame(file, i, -8, "ref-out");
    const refIn = frame(file, i, FRAMES + 8, "ref-in");
    const before = frame(file, i, -1, "before");
    const after = frame(file, i, FRAMES, "after");
    const mid = frame(file, i, FRAMES / 2, "mid");
    const near = (g: Buffer, ref: Buffer, x0: number, y0: number, x1: number, y1: number) => dist(at(g, x0, y0, x1, y1), at(ref, x0, y0, x1, y1));
    // Up to its first frame the outgoing scene is untouched; from the frame it ends, the next one is
    // clean (no filter, mask, scale or light left behind).
    expect(diff(before, refOut), `${type}: untouched before`).toBeLessThan(3);
    expect(diff(after, refIn), `${type}: clean after`).toBeLessThan(3);
    expect(dist(at(refOut, 0.3, 0.3, 0.7, 0.7), at(refIn, 0.3, 0.3, 0.7, 0.7)), "scenes differ").toBeGreaterThan(60);
    expect(diff(mid, refOut), `${type}: something happens`).toBeGreaterThan(8);

    if (type === "liquid") {
      // The next scene has flooded in from one side: one edge shows it, the other the outgoing scene.
      expect(near(mid, refIn, 0, 0.3, 0.12, 0.7), "liquid: next scene behind the front").toBeLessThan(25);
      expect(near(mid, refOut, 0.88, 0.3, 1, 0.7), "liquid: outgoing ahead of the front").toBeLessThan(25);
    } else if (type === "lens") {
      // The lens shows the next scene; a corner far from it still shows the outgoing one.
      const lensMid = frame(file, i, Math.round(FRAMES * 0.45), "lens");
      const corners = [[0, 0], [0.9, 0], [0, 0.88], [0.9, 0.88]].map(([x, y]) => near(lensMid, refOut, x!, y!, x! + 0.1, y! + 0.12));
      expect(Math.min(...corners), "lens: outgoing outside the lens").toBeLessThan(25);
      let best = Infinity;
      for (let y = 0.1; y < 0.9; y += 0.1) for (let x = 0.1; x < 0.9; x += 0.1) best = Math.min(best, dist(at(lensMid, x, y, x + 0.06, y + 0.06), inc(x, y)));
      expect(best, "lens: next scene inside the lens").toBeLessThan(30);
      function inc(x: number, y: number) {
        return at(refIn, x, y, x + 0.06, y + 0.06);
      }
    } else if (type === "grain") {
      // A dissolve, not a wipe: both scenes are mixed across the frame, in grainy patches, and the
      // mix grows over the transition (not all at once).
      const share = (g: Buffer) => {
        let nIn = 0;
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            const c = at(g, x / W, y / H, (x + 1) / W, (y + 1) / H);
            if (dist(c, at(refIn, x / W, y / H, (x + 1) / W, (y + 1) / H)) < dist(c, at(refOut, x / W, y / H, (x + 1) / W, (y + 1) / H))) nIn++;
          }
        return nIn / (W * H);
      };
      const s1 = share(frame(file, i, Math.round(FRAMES * 0.35), "g35")), s2 = share(mid), s3 = share(frame(file, i, Math.round(FRAMES * 0.65), "g65"));
      expect(s2, "grain: both scenes in the mix").toBeGreaterThan(0.15);
      expect(s2, "grain: both scenes in the mix").toBeLessThan(0.85);
      expect(s1, "grain: the dissolve grows").toBeLessThan(s2);
      expect(s2, "grain: the dissolve grows").toBeLessThan(s3);
    } else {
      // At the swap the shape has closed: neither scene shows, only the brand fill.
      const swap = frame(file, i, FRAMES / 2, "swap");
      expect(near(swap, refOut, 0.45, 0.45, 0.55, 0.55), "morph: outgoing hidden at the swap").toBeGreaterThan(30);
      expect(near(swap, refIn, 0.45, 0.45, 0.55, 0.55), "morph: next hidden at the swap").toBeGreaterThan(30);
      // Closing in (it accelerates into the swap), the outgoing scene shows inside the shape and the
      // fill outside it.
      const q = frame(file, i, Math.round(FRAMES * 0.4), "closing");
      expect(near(q, refOut, 0.47, 0.47, 0.53, 0.53), "morph: outgoing inside the shape").toBeLessThan(30);
      expect(near(q, refOut, 0, 0, 0.06, 0.08), "morph: fill outside the shape").toBeGreaterThan(30);
      // The shrinking scene never leaves a bare edge: early frames show scene or fill, never the page.
      for (const k of [1, 2, 3]) {
        const e = frame(file, i, k, `edge${k}`);
        expect(near(e, refOut, 0, 0.4, 0.02, 0.6), `morph: no bare edge at frame ${k}`).toBeLessThan(40);
      }
    }
  }

  // Repeatable: the same revision renders the same transition frames.
  await ops(request, id, [{ op: "setTitle", title: "Shader transitions (again)" }]);
  const again = await render("shader-transitions-again");
  for (const [i, type] of TRANSITIONS.entries()) {
    expect(diff(frame(file, i, FRAMES / 2 - 3, "r1"), frame(again, i, FRAMES / 2 - 3, "r2")), `${type} repeats`).toBeLessThan(1);
  }
});
