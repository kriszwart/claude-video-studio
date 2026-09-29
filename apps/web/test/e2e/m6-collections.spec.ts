import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { ART, downloadAndProbe, FIX, frameAt, renderAndWait } from "./helpers";

const EVENT = join(FIX, "event");
type Item = { id: string; sourceName: string; status: string; error: string | null; transcriptId: string | null; assetId: string | null; bytes: number };
type View = { items: Item[]; totals: { files: number; bytes: number; byStatus: Record<string, number> } };

async function view(request: APIRequestContext, id: string): Promise<View> {
  return (await request.get(`/api/collections/${id}`)).json();
}
async function until(request: APIRequestContext, id: string, ok: (v: View) => boolean, what: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await request.get(`/api/collections/${id}`);
    const v = r.ok() ? ((await r.json().catch(() => null)) as View | null) : null;
    if (v && ok(v)) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Mono 8 kHz RMS envelope (20 ms hops) of a file range. */
function envelope(file: string, start: number, dur: number): number[] {
  const buf = execFileSync("ffmpeg", ["-v", "error", "-ss", start.toFixed(3), "-t", dur.toFixed(3), "-i", file, "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"], { maxBuffer: 1 << 26 });
  const x = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  const hop = 160;
  const out: number[] = [];
  for (let i = 0; i + hop <= x.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += x[j]! * x[j]!;
    out.push(Math.sqrt(s / hop));
  }
  return out;
}
function corr(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length);
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}
function maxDb(file: string, start: number, dur: number) {
  const out = execFileSync("sh", ["-c", `ffmpeg -hide_banner -ss ${start.toFixed(3)} -t ${dur.toFixed(3)} -i '${file}' -vn -af volumedetect -f null - 2>&1 | grep max_volume || true`]).toString();
  return Number(/max_volume: (-?[\d.]+)/.exec(out)?.[1] ?? "-120");
}

test.describe.serial("M6: event collection → quotes → P3 sizzle", () => {
  let collectionId = "";

  test("A20: resumable, limited, hash-reusing collection ingest", async ({ page, request }) => {
    const name = `Harbor Summit ${Date.now()}`;
    // Tight limits so rejections are visible: 11 files (the fixture folder), 400 KB each.
    const c = await (await request.post("/api/collections", { data: { name, limits: { maxFiles: 11, maxFileBytes: 400_000 } } })).json();
    collectionId = c.collection.id;

    // Per-file limit: rejected with a clear message before any bytes are sent.
    const big = await request.post(`/api/collections/${collectionId}/uploads`, { data: { filename: "keynote-4k.mp4", mime: "video/mp4", bytes: 5_000_000, rightsAcknowledged: true } });
    expect(big.status()).toBe(413);
    expect((await big.json()).error.message).toMatch(/per-file limit/);

    // Interrupted upload: send half of a recording, then "lose the connection".
    const file = join(EVENT, "opening-welcome.mp4");
    const bytes = readFileSync(file);
    const reserve = () => request.post(`/api/collections/${collectionId}/uploads`, { data: { filename: "opening-welcome.mp4", relativePath: "event/opening-welcome.mp4", mime: "video/mp4", bytes: bytes.length, rightsAcknowledged: true } });
    const first = await (await reserve()).json();
    expect(first.created).toBe(true);
    const half = Math.floor(bytes.length / 2);
    const put1 = await request.put(first.uploadUrl, { data: bytes.subarray(0, half), headers: { "content-range": `bytes 0-${half - 1}/${bytes.length}`, "content-type": "application/octet-stream" } });
    expect((await put1.json()).complete).toBe(false);
    // Re-selecting the same file returns the same item and upload, with the server's offset.
    const again = await (await reserve()).json();
    expect(again.created).toBe(false);
    expect(again.item.id).toBe(first.item.id);
    const status = await (await request.get(again.uploadUrl)).json();
    expect(status.received).toBe(half);
    // A chunk that doesn't start at the received offset is refused (no double-writes).
    const wrong = await request.put(again.uploadUrl, { data: bytes.subarray(0, 10), headers: { "content-range": `bytes 0-9/${bytes.length}` } });
    expect(wrong.status()).toBe(409);
    const put2 = await request.put(again.uploadUrl, { data: bytes.subarray(half), headers: { "content-range": `bytes ${half}-${bytes.length - 1}/${bytes.length}` } });
    expect((await put2.json()).complete).toBe(true);
    await request.post(`/api/assets/${again.asset.id}/finalize`);

    // The rest arrives through the browser's folder picker. The already-uploaded file is skipped.
    await page.goto(`/collections/${collectionId}`);
    await page.getByLabel("I have the rights to use these recordings").check();
    await page.locator('input[type="file"][webkitdirectory]').setInputFiles(EVENT);
    await expect(page.getByText(/opening-welcome\.mp4: already uploaded — skipped/)).toBeVisible({ timeout: 60_000 });
    let v = await until(request, collectionId, (x) => x.items.length >= 11 && x.items.every((i) => !["pending", "probing"].includes(i.status)), "uploads");
    // Every fixture file became an item; totals are shown.
    expect(v.items.map((i) => i.sourceName).sort()).toEqual(expect.arrayContaining(["event/opening-welcome.mp4", "event/attendee-leo.mp4", "event/session-notes-audio.m4a", "event/closing-invitation.srt"]));
    await expect(page.getByTestId("collection-totals")).toContainText(/11 files/);
    // File-count limit: a 12th file is refused with a visible reason.
    const extra = await request.post(`/api/collections/${collectionId}/uploads`, { data: { filename: "extra.mp4", mime: "video/mp4", bytes: 1000, rightsAcknowledged: true } });
    expect(extra.status()).toBe(413);
    expect((await extra.json()).error.message).toMatch(/limited to 11 files/);

    // Index a representative subset first; the plan shows what will happen before anything runs.
    await page.reload();
    for (const n of ["event/opening-welcome.mp4", "event/attendee-maya.mp4"]) await page.getByLabel(`Select ${n}`).check();
    await page.getByRole("button", { name: /Index selected \(2\)/ }).click();
    const plan = page.getByRole("dialog", { name: "Indexing estimate" });
    // First run imports the sidecar subtitles; identical content indexed before is reused instead.
    await expect(plan).toContainText(/event\/opening-welcome\.mp4: (import matching subtitles|reuse existing transcript)/);
    await expect(plan).toContainText(/0\.0 min to transcribe/);
    await page.screenshot({ path: join(ART, "m6-index-plan.png") });
    await plan.getByRole("button", { name: "Start indexing" }).click();
    v = await until(request, collectionId, (x) => ["event/opening-welcome.mp4", "event/attendee-maya.mp4"].every((n) => x.items.find((i) => i.sourceName === n)?.status === "indexed"), "subset indexed");
    const firstTranscripts = Object.fromEntries(v.items.filter((i) => i.transcriptId).map((i) => [i.id, i.transcriptId]));

    // Then everything: indexed items are skipped; the audio file without subtitles is visible as needing a transcript.
    const all = await (await request.post(`/api/collections/${collectionId}/index`, { data: { all: true, dryRun: true } })).json();
    const act = Object.fromEntries(all.plan.items.map((i: { sourceName: string; action: string }) => [i.sourceName, i.action]));
    expect(act["event/opening-welcome.mp4"]).toBe("skip_indexed");
    expect(act["event/attendee-maya.mp4"]).toBe("skip_indexed");
    expect(["sidecar", "reuse"]).toContain(act["event/talk-migration-lessons.mp4"]);
    expect(act["event/session-notes-audio.m4a"]).toBe("needs_transcript");
    expect(act["event/attendee-leo.srt"]).toBe("not_media");
    const run = await (await request.post(`/api/collections/${collectionId}/index`, { data: { all: true } })).json();
    expect(run.jobs.map((j: { itemId: string }) => j.itemId)).not.toContain(Object.keys(firstTranscripts)[0]);
    v = await until(request, collectionId, (x) => x.items.filter((i) => /\.(mp4|m4a)$/.test(i.sourceName)).every((i) => ["indexed", "needs_transcript", "failed"].includes(i.status)), "all indexed");
    for (const [itemId, tid] of Object.entries(firstTranscripts)) expect(v.items.find((i) => i.id === itemId)!.transcriptId).toBe(tid);
    expect(v.items.find((i) => i.sourceName === "event/session-notes-audio.m4a")!.status).toBe("needs_transcript");
    expect(v.totals.byStatus.indexed).toBe(5);
    await page.reload();
    await expect(page.getByText(/needs a transcript|No transcript yet/).first()).toBeVisible();
    await page.screenshot({ path: join(ART, "m6-collection.png"), fullPage: true });

    // Reindexing the same content elsewhere reuses the transcript (hash-based reuse): a second collection.
    const c2 = await (await request.post("/api/collections", { data: { name: `${name} (copy)` } })).json();
    const r2 = await (await request.post(`/api/collections/${c2.collection.id}/uploads`, { data: { filename: "attendee-maya.mp4", mime: "video/mp4", bytes: statSync(join(EVENT, "attendee-maya.mp4")).size, rightsAcknowledged: true } })).json();
    await request.put(r2.uploadUrl, { data: readFileSync(join(EVENT, "attendee-maya.mp4")), headers: { "content-type": "application/octet-stream" } });
    await request.post(`/api/assets/${r2.asset.id}/finalize`);
    await until(request, c2.collection.id, (x) => x.items[0]?.status === "uploaded", "copy uploaded");
    const p2 = await (await request.post(`/api/collections/${c2.collection.id}/index`, { data: { all: true, dryRun: true } })).json();
    expect(p2.plan.items[0].action).toBe("reuse");
  });

  test("A19: authentic quotes → P3 sizzle with clean handles, ducked music and the approved logo", async ({ page, request }) => {
    test.setTimeout(20 * 60_000);
    await page.goto(`/collections/${collectionId}`);
    const pick = async (theme: string, text: RegExp) => {
      await page.getByRole("button", { name: theme, exact: true }).click();
      const card = page.getByTestId("quote-candidate").filter({ has: page.locator("strong", { hasText: text }) });
      await expect(card).toBeVisible();
      await expect(card.locator("video")).toHaveAttribute("src", /#t=/);
      await card.getByRole("button", { name: "Use this quote" }).click();
    };
    await pick("Opening energy", /welcome to Harbor Summit/);
    await page.getByTestId("picked-quote").last().getByRole("button", { name: "+ after" }).click();
    await expect(page.getByTestId("picked-quote").last()).toContainText("three hundred builders");
    await pick("Practical outcome", /forty minutes to six/);
    await pick("Audience reaction", /best workshop/);
    await pick("Audience reaction", /hallway conversations were incredible/);
    await pick("Closing invitation", /Join us in Lisbon/);
    // A candidate shows the surrounding transcript for context.
    await expect(page.getByTestId("quote-candidate").filter({ has: page.locator("strong", { hasText: /Join us in Lisbon/ }) })).toContainText("Next year we are going bigger.");
    await page.getByLabel("Speaker credit").nth(2).fill("Attendee");
    await page.getByLabel("Event name").fill("Harbor Summit");
    await page.getByLabel(/Next-event details/).fill("Harbor Summit 2027 · Lisbon · 14–15 May\nCommunity tickets open now");
    await page.getByLabel("Call to action").fill("Register at harbor.example");
    const logoPicker = page.locator("div.text-xs", { hasText: "Logo (approved)" });
    await logoPicker.getByRole("button", { name: /Choose image/ }).click();
    await logoPicker.getByLabel(/I have the rights/).check();
    await logoPicker.locator('input[type="file"]').setInputFiles(join(FIX, "logo-harbor-summit.svg"));
    await expect(logoPicker.locator(".chip")).toContainText("logo-harbor-summit", { timeout: 60_000 });
    const musicPicker = page.locator("div.text-xs", { hasText: "Music bed" });
    await musicPicker.getByRole("button", { name: /Choose audio/ }).click();
    await musicPicker.getByLabel(/I have the rights/).check();
    await musicPicker.locator('input[type="file"]').setInputFiles(join(FIX, "music-launch-bed.m4a"));
    await expect(musicPicker.locator(".chip")).toContainText("music-launch-bed", { timeout: 60_000 });
    await page.screenshot({ path: join(ART, "m6-quote-review.png"), fullPage: true });
    await page.getByRole("button", { name: /Build sizzle reel \(5 quotes\)/ }).click();
    await page.waitForURL(/\/projects\/prj_/, { timeout: 120_000 });
    const projectId = page.url().split("/projects/")[1]!.split(/[?#]/)[0]!;

    const v = await (await request.get(`/api/projects/${projectId}`)).json();
    const doc = v.doc;
    const quotes = doc.scenes.filter((s: { quote?: unknown }) => s.quote);
    expect(quotes.map((s: { quote: { theme: string } }) => s.quote.theme)).toEqual(["energy", "outcome", "reaction", "reaction", "invitation"]);
    // Verbatim: every quote's text is exactly its transcript segments; captions are chunks of it.
    for (const s of quotes) {
      const t = await (await request.get(`/api/collections/${collectionId}/items/${(await view(request, collectionId)).items.find((i) => i.transcriptId === s.quote.transcriptId)!.id}`)).json();
      const segs = t.transcript.segments.filter((x: { id: string }) => s.quote.segmentIds.includes(x.id));
      expect(s.quote.text).toBe(segs.map((x: { text: string }) => x.text).join(" "));
      const cues = doc.captions.cues.filter((c: { anchor: { sceneId?: string } }) => c.anchor.sceneId === s.id).map((c: { text: string }) => c.text);
      expect(cues.join(" ")).toBe(s.quote.text);
      expect(s.quote.clipInSec).toBeLessThan(s.quote.speechInSec);
      expect(s.quote.clipOutSec).toBeGreaterThan(s.quote.speechOutSec);
    }
    // The last scene is the invitation end card with the approved logo and facts, exactly as written.
    const end = doc.scenes.at(-1);
    expect(end.layers.find((l: { kind: string }) => l.kind === "image").assetId).toBeTruthy();
    expect(end.layers.map((l: { text?: string }) => l.text)).toContain("Harbor Summit 2027 · Lisbon · 14–15 May");
    expect(doc.audio.find((a: { kind: string }) => a.kind === "music").duck.enabled).toBe(true);

    // Quote integrity: trimming into the words or rewriting a quote is refused.
    const bad = await request.post(`/api/projects/${projectId}/operations`, { data: { baseRevisionId: v.revision.id, ops: [{ op: "setLayerMedia", sceneId: quotes[0].id, layerId: quotes[0].layers[0].id, sourceInSec: quotes[0].quote.speechInSec + 0.5, sourceOutSec: quotes[0].quote.clipOutSec }] } });
    expect(bad.status(), await bad.text()).toBe(422);
    const rewritten = structuredClone(quotes[1]);
    rewritten.quote.text = "We cut our build time from forty minutes to one.";
    const bad2 = await request.post(`/api/projects/${projectId}/operations`, { data: { baseRevisionId: v.revision.id, ops: [{ op: "replaceScenes", scenes: doc.scenes.map((s: { id: string }) => (s.id === rewritten.id ? rewritten : s)) }] } });
    expect(bad2.status()).toBe(422);
    expect((await bad2.json()).error.code).toBe("quote_integrity");

    // The inspector links each quote to its playable original range.
    await page.getByText(/Reaction: Honestly, this was the best workshop/).first().click();
    const src = page.getByTestId("quote-source");
    await expect(src).toContainText("event/attendee-maya.mp4");
    const videoSrc = await src.locator("video").getAttribute("src");
    expect(videoSrc).toMatch(/#t=\d/);
    const head = await request.get(videoSrc!.split("#")[0]!, { headers: { range: "bytes=0-1023" } });
    expect([200, 206]).toContain(head.status());

    // Export and verify: each quote's audio in the export matches its source range (envelope correlation),
    // the source clip starts and ends in room tone (no truncated words), and music sits under speech.
    const { job } = await renderAndWait(request, projectId, "exports");
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    const pv = await (await request.get(`/api/projects/${projectId}`)).json();
    const exp = pv.exports.find((e: { jobId: string }) => e.jobId === job.id);
    const { file, probe } = await downloadAndProbe(page, exp.downloadUrl, "m6-event-sizzle.mp4");
    expect(probe.streams.map((s: { codec_name: string }) => s.codec_name)).toEqual(["h264", "aac"]);
    const fps = doc.format.fps;
    let start = 0;
    const report: Record<string, unknown>[] = [];
    for (const [i, s] of doc.scenes.entries()) {
      if (i > 0) start -= s.transitionIn.durationFrames;
      if (s.quote) {
        const q = s.quote;
        const srcFile = join(EVENT, q.sourceName.replace(/^event\//, ""));
        const dur = q.clipOutSec - q.clipInSec;
        const r = corr(envelope(file, start / fps, dur), envelope(srcFile, q.clipInSec, dur));
        const edgeIn = maxDb(srcFile, q.clipInSec, 0.06);
        const edgeOut = maxDb(srcFile, q.clipOutSec - 0.06, 0.06);
        report.push({ scene: i + 1, source: q.sourceName, clip: [q.clipInSec, q.clipOutSec], words: [q.speechInSec, q.speechOutSec], envelopeCorr: Number(r.toFixed(3)), sourceEdgePeakDb: [edgeIn, edgeOut] });
        expect(r).toBeGreaterThan(0.8);
        expect(edgeIn).toBeLessThan(-30);
        expect(edgeOut).toBeLessThan(-30);
        frameAt(file, (start + s.durationFrames / 2) / fps, `m6-sizzle-scene${i + 1}.png`);
      }
      start += s.durationFrames;
    }
    frameAt(file, start / fps - 1, "m6-sizzle-endcard.png");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-lavfi", "showspectrumpic=s=960x240:legend=0", join(ART, "m6-sizzle-spectrum.png")]);
    writeFileSync(join(ART, "m6-sizzle-report.json"), JSON.stringify({ quotes: report, loudness: exp.loudness, speechIntervals: exp.speechIntervals }, null, 2));
    expect(exp.speechIntervals.length).toBeGreaterThan(0);
  });
});
