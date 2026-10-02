import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { computeTimeline, type ProjectDocument } from "@vs/domain";
import { apiUpload, createProject, downloadAndProbe, FIX, frameAt, renderAndWait } from "./helpers";

/**
 * The payoff moment: a counting number (real values from the approved facts) and the music locked
 * to it — the song's drop lands on the number's last value and the cuts sit on beats.
 */
const view = async (request: APIRequestContext, id: string) => (await request.get(`/api/projects/${id}`)).json();
const ops = async (request: APIRequestContext, id: string, o: unknown[]) => {
  const v = await view(request, id);
  const r = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: o } });
  expect(r.status(), await r.text()).toBe(200);
};
/** Mean absolute difference of a region of two frames (fractions of width/height). */
function regionDiff(a: string, b: string, r: { x: number; y: number; w: number; h: number }) {
  const g = (f: string) => execFileSync("ffmpeg", ["-v", "error", "-i", f, "-vf", `crop=iw*${r.w}:ih*${r.h}:iw*${r.x}:ih*${r.y},scale=160:60,format=gray`, "-f", "rawvideo", "-"]);
  const x = g(a), y = g(b);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += Math.abs(x[i]! - y[i]!);
  return s / x.length;
}

test("a counting number of real values, with the song's drop landing on its last value", async ({ page, request }) => {
  test.setTimeout(20 * 60_000);
  const song = await apiUpload(request, join(FIX, "music-song.m4a"), "audio/mp4");
  const shot = await apiUpload(request, join(FIX, "tidewave-dashboard.png"), "image/png");
  const { project } = await createProject(request, {
    templateId: "product-launch",
    title: "Beat lock",
    inputs: { productName: "Tallyo", promise: "Invoices that chase themselves", problem: "You did the work. Now you're chasing the money.", benefits: ["Who owes me: £7,675.00 across four clients"], proof: ["Paid in a week: £3,150, £2,400, £1,275 and £850"], proofSource: "Pilot", cta: "Sign up free", music: song, screenshots: [shot] },
  });
  const id = project.id;
  let doc = (await view(request, id)).doc as ProjectDocument;
  const pi = doc.scenes.findIndex((s) => s.recipeSlot === "proof");
  const proof = doc.scenes[pi]!;
  await ops(request, id, [{ op: "addLayer", sceneId: proof.id, layer: { id: "lyr_total", kind: "text", slot: "quote", role: "stat", text: "£7,675.00", box: { x: 0.1, y: 0.3, w: 0.8, h: 0.3 }, animation: { in: "fade", delayFrames: 0 } } }]);
  await ops(request, id, [{ op: "setLayerHidden", sceneId: proof.id, layerId: proof.layers.find((l) => l.kind === "text" && l.role === "quote")!.id, hidden: true }]);

  // The Scene tab turns the number into a counter; an invented stop is flagged.
  await page.goto(`/projects/${id}`);
  await page.getByRole("navigation", { name: "Scenes" }).locator("li").nth(pi).getByRole("button").first().click();
  await page.getByRole("tab", { name: "scene" }).click();
  await page.getByRole("button", { name: "Make this number count" }).click();
  const ed = page.getByTestId("count-editor");
  await expect(ed).toContainText("£0.00 → £7,675.00");
  const first = ed.locator("li").first().locator("input").first();
  await first.fill("5000");
  await first.press("Enter");
  await expect(ed).toContainText("£5,000.00 isn't in your approved facts");

  // The real path: the total counts down by each paid amount, to £0.00 on the payoff.
  const fps = doc.format.fps;
  const stops = [7675, 4525, 2125, 850, 0].map((value, i) => ({ value, atFrames: Math.round((0.4 + i * 0.6) * fps) }));
  await ops(request, id, [{ op: "setLayerCount", sceneId: proof.id, layerId: "lyr_total", count: { prefix: "£", suffix: "", decimals: 2, thousands: true, stops } }]);
  await expect(ed).not.toContainText("isn't in your approved facts");

  // Lock to the beat from the Audio tab (auto payoff: the counter's scene).
  await page.getByRole("tab", { name: "audio" }).click();
  const lock = page.getByTestId("beat-lock");
  await expect(lock.getByLabel("Payoff scene")).toContainText(`Auto: ${proof.purpose}`);
  await lock.getByRole("button", { name: "Lock to the beat" }).click();
  await expect(lock.getByTestId("beat-lock-result")).toBeVisible({ timeout: 180_000 });
  await expect(lock.getByTestId("beat-lock-result")).toContainText(`lands on “${proof.purpose}”`);

  doc = (await view(request, id)).doc;
  const tl = computeTimeline(doc);
  const music = doc.audio.find((t) => t.kind === "music")!;
  const start = music.anchor.type === "absolute" ? music.anchor.startFrame : 0;
  const payoff = tl.scenes[pi]!.start + stops.at(-1)!.atFrames;
  const drop = doc.markers.find((m) => m.label === "drop")!;
  expect(drop.frame).toBe(payoff);
  const songAt = (frame: number) => music.sourceInSec + (frame - start) / fps;
  const job = (await view(request, id)).jobs.find((j: { type: string }) => j.type === "lock_music");
  expect(Math.abs(songAt(payoff) - job.result.drop.sec)).toBeLessThan(1 / fps);
  // A drop late enough in the song is chosen, so the music starts with the video (or within a second).
  expect(job.result.musicDelaySec).toBeLessThan(1);

  // Rendered: the number changes at each stop and holds between.
  const { view: after } = await renderAndWait(request, id, "preview");
  const exp = after.exports.find((e: { kind: string }) => e.kind === "preview");
  const { file } = await downloadAndProbe(page, exp.downloadUrl, "beat-lock.mp4");
  const s0 = tl.scenes[pi]!.start / fps;
  const at = (k: string, t: number) => frameAt(file, t, `beat-lock-${k}.png`);
  const box = { x: 0.1, y: 0.3, w: 0.8, h: 0.3 };
  const a1 = at("stop1", s0 + stops[1]!.atFrames / fps + 0.05), a1b = at("stop1b", s0 + stops[1]!.atFrames / fps + 0.2);
  const a2 = at("stop2", s0 + stops[2]!.atFrames / fps + 0.05), end = at("end", s0 + stops[4]!.atFrames / fps + 0.1);
  expect(regionDiff(a1, a1b, box)).toBeLessThan(2); // holds on £4,525.00
  expect(regionDiff(a1, a2, box)).toBeGreaterThan(2); // then shows £2,125.00
  expect(regionDiff(a2, end, box)).toBeGreaterThan(2);
});
