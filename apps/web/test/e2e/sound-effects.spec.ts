import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { computeTimeline, resolveAnchor, SOUND_ROLES, type ProjectDocument } from "@vs/domain";
import { apiUpload, ART, createProject, downloadAndProbe, renderAndWait } from "./helpers";

/**
 * Sound effects: a kit of short sounds (TEST FIXTURES generated here with ffmpeg; real kits are
 * recordings the owner uploads), measured on upload, placed from the Audio tab, and checked in
 * the rendered mix: each sound's hit lands on its moment.
 */
const DIR = join(ART, "sfx-fixtures");
const SR = 16_000;

function fixture(name: string, expr: string, dur: number) {
  mkdirSync(DIR, { recursive: true });
  const out = join(DIR, `${name}.wav`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${expr}':d=${dur}:s=44100`, "-ac", "1", out]);
  return out;
}
/** 5 ms RMS envelope of a file's audio. */
function envelope(file: string): number[] {
  const buf = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  const s = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + Math.floor(buf.length / 4) * 4));
  const win = SR * 0.005;
  const env: number[] = [];
  for (let o = 0; o < s.length; o += win) {
    let a = 0;
    for (let i = o; i < Math.min(s.length, o + win); i++) a += s[i]! * s[i]!;
    env.push(Math.sqrt(a / win));
  }
  return env;
}
const clearKit = async (request: APIRequestContext) => {
  for (const role of SOUND_ROLES) await request.put("/api/sfx", { data: { role, assetId: null } });
};

test.describe.serial("Sound effects", () => {
  test.afterAll(async ({ request }) => clearKit(request));

  test("sounds are measured on upload; placed effects land their hit on the moment in the rendered mix", async ({ page, request }) => {
    test.setTimeout(20 * 60_000);
    await clearKit(request);
    // A whoosh that swells to its peak at 0.70 s, and a chime that strikes after 30 ms of silence.
    const whoosh = await apiUpload(request, fixture("whoosh", "if(lt(t,0.7),pow(t/0.7,3),max(0,1-(t-0.7)/0.4))*(random(0)*2-1)*0.7", 1.2), "audio/wav");
    const chime = await apiUpload(request, fixture("chime", "if(lt(t,0.03),0,sin(2*PI*880*t)*exp(-3*(t-0.03))*0.6)", 2.5), "audio/wav");
    const long = await apiUpload(request, fixture("long", "sin(2*PI*220*t)*0.3", 25), "audio/wav");

    // A sound longer than 20 s is not a sound effect.
    expect((await request.put("/api/sfx", { data: { role: "pop", assetId: long } })).status()).toBe(422);
    await request.put("/api/sfx", { data: { role: "whoosh", assetId: whoosh } });
    const kit = (await (await request.put("/api/sfx", { data: { role: "chime", assetId: chime } })).json()).kit as { role: string; hitSec: number }[];
    const hit = (r: string) => kit.find((k) => k.role === r)!.hitSec;
    expect(hit("whoosh")).toBeGreaterThan(0.55);
    expect(hit("whoosh")).toBeLessThanOrEqual(0.71);
    expect(hit("chime")).toBeCloseTo(0.03, 2);

    const { project } = await createProject(request, { templateId: "motion-reel", title: "Sound effects", inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave", cta: "tidewave.example" } });
    const id = project.id;
    await page.goto(`/projects/${id}`);
    await page.getByRole("tab", { name: "audio" }).click();
    const panel = page.getByTestId("sound-effects");
    await panel.getByRole("button", { name: /Sound kit/ }).or(panel.locator("summary", { hasText: "Sound kit" })).first().click();
    await expect(panel.getByTestId("kit-whoosh")).toContainText(`hits at ${Math.round(hit("whoosh") * 1000)} ms`);
    await panel.getByLabel("Sound effect density").selectOption("minimal");
    await panel.getByRole("button", { name: "Add sound effects" }).click();
    const list = panel.getByTestId("placed-effects");
    await expect(list).toBeVisible({ timeout: 60_000 });
    await expect(list.locator('[data-role="chime"]')).toHaveCount(1);
    expect(await list.locator('[data-role="whoosh"]').count()).toBeGreaterThan(0);

    const view = await (await request.get(`/api/projects/${id}`)).json();
    const doc = view.doc as ProjectDocument;
    const fps = doc.format.fps;
    const tl = computeTimeline(doc);
    const placed = doc.audio.filter((t) => t.sfx);
    const lands = placed.map((t) => ({ role: t.sfx!.role, at: resolveAnchor(t.anchor, tl)! / fps - t.sourceInSec + hit(t.sfx!.role) }));

    // Re-placing replaces; nothing is doubled.
    await panel.getByRole("button", { name: "Re-place sound effects" }).click();
    await expect.poll(async () => (await (await request.get(`/api/projects/${id}`)).json()).doc.audio.filter((t: { sfx?: unknown }) => t.sfx).length, { timeout: 60_000 }).toBe(placed.length);

    // The rendered mix: around each moment, the sound first gets loud on the moment.
    const { view: after } = await renderAndWait(request, id, "preview");
    const exp = after.exports.find((e: { kind: string }) => e.kind === "preview");
    const { file } = await downloadAndProbe(page, exp.downloadUrl, "sfx-preview.mp4");
    const env = envelope(file);
    for (const l of lands) {
      const i0 = Math.max(0, Math.round((l.at - 0.25) / 0.005)), i1 = Math.round((l.at + 0.25) / 0.005);
      const win = env.slice(i0, i1);
      const max = Math.max(...win);
      const first = win.findIndex((v) => v >= 0.6 * max);
      const measured = (i0 + first) * 0.005;
      console.log(`[sfx] ${l.role} moment ${l.at.toFixed(3)} s, hit in mix ${measured.toFixed(3)} s`);
      expect(Math.abs(measured - l.at), `${l.role} at ${l.at.toFixed(3)} s measured ${measured.toFixed(3)} s`).toBeLessThan(0.02);
    }
  });
});
