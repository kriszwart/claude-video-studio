import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { findDuplicate, getDb, getStore, JobError, schema, UPLOAD_LIMITS } from "@vs/db";
import { FFMPEG, probeMedia, resolveChromePath, run, runOk } from "@vs/rendering";
import { chromium } from "playwright-core";
import { sha256File, type Handler } from "../context";

async function magic(path: string, n = 16): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const b = Buffer.alloc(n);
    await fh.read(b, 0, n, 0);
    return b;
  } finally {
    await fh.close();
  }
}

export function sniffImage(b: Buffer): "png" | "jpeg" | "webp" | "gif" | null {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "webp";
  if (b.subarray(0, 4).toString() === "GIF8") return "gif";
  return null;
}

export function sniffFont(b: Buffer): "ttf" | "otf" | "woff" | "woff2" | null {
  const h = b.subarray(0, 4);
  if (h.equals(Buffer.from([0, 1, 0, 0])) || h.toString() === "true") return "ttf";
  if (h.toString() === "OTTO") return "otf";
  if (h.toString() === "wOFF") return "woff";
  if (h.toString() === "wOF2") return "woff2";
  return null;
}

/** Rasterise an untrusted SVG with JavaScript disabled and all network requests blocked. */
export async function rasterizeSvg(svgPath: string, outPng: string): Promise<{ width: number; height: number }> {
  const svg = await readFile(svgPath, "utf8");
  if (!/<svg[\s>]/i.test(svg.slice(0, 4096))) throw new JobError("invalid_svg", "This file is not an SVG image.", false);
  if (svg.length > 5 * 1024 * 1024) throw new JobError("invalid_svg", "SVG is too large (5 MB limit).", false);
  const browser = await chromium.launch({ executablePath: await resolveChromePath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 2048, height: 2048 }, offline: true });
    await ctx.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
    const page = await ctx.newPage();
    // Load as an <img>: SVG-as-image never runs scripts or fetches external resources.
    const data = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    await page.setContent(`<html><body style="margin:0;background:transparent"><img id="i" src="${data}" style="max-width:2048px;max-height:2048px;display:block"></body></html>`);
    const size = await page.evaluate(async () => {
      const img = document.getElementById("i") as HTMLImageElement;
      if (!img.complete) await new Promise((r) => (img.onload = img.onerror = r));
      let w = img.naturalWidth || 1024;
      let h = img.naturalHeight || 1024;
      const s = Math.min(2048 / w, 2048 / h, 4);
      w = Math.round(w * s);
      h = Math.round(h * s);
      img.style.width = `${w}px`;
      img.style.height = `${h}px`;
      return { w, h };
    });
    if (!size.w || !size.h) throw new JobError("invalid_svg", "The SVG could not be rendered.", false);
    await page.locator("#i").screenshot({ path: outPng, omitBackground: true });
    return { width: size.w, height: size.h };
  } finally {
    await browser.close();
  }
}

async function fontFamily(path: string): Promise<string | null> {
  const r = await run("fc-scan", ["--format", "%{family[0]}", path], { timeoutMs: 15_000 }).catch(() => null);
  const name = r?.code === 0 ? r.stdout.trim() : "";
  return name && name.length < 80 ? name : null;
}

export async function audioPeaks(path: string, buckets = 480): Promise<number[]> {
  const r = await new Promise<Buffer>((resolve, reject) => {
    import("node:child_process").then(({ spawn }) => {
      const p = spawn(FFMPEG, ["-hide_banner", "-nostdin", "-i", path, "-ac", "1", "-ar", "4000", "-f", "s16le", "-"], { stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      p.stdout.on("data", (c) => chunks.push(c));
      p.on("close", () => resolve(Buffer.concat(chunks)));
      p.on("error", reject);
    });
  });
  const samples = r.length / 2;
  if (samples === 0) return [];
  const per = Math.max(1, Math.floor(samples / buckets));
  const peaks: number[] = [];
  for (let b = 0; b < buckets && b * per < samples; b++) {
    let m = 0;
    for (let i = b * per; i < Math.min(samples, (b + 1) * per); i++) m = Math.max(m, Math.abs(r.readInt16LE(i * 2)));
    peaks.push(Number((m / 32768).toFixed(3)));
  }
  return peaks;
}

export const ingestAsset: Handler = async (ctx) => {
  const db = getDb();
  const store = getStore();
  const assetId = String(ctx.job.input.assetId);
  const asset = await db.query.assets.findFirst({ where: and(eq(schema.assets.id, assetId), eq(schema.assets.workspaceId, ctx.job.workspaceId)) });
  if (!asset) throw new JobError("not_found", "Asset not found.", false);
  if (asset.status === "ready") return { assetId, alreadyReady: true };
  const fail = async (code: string, message: string) => {
    await db.update(schema.assets).set({ status: "failed", error: message }).where(eq(schema.assets.id, assetId));
    throw new JobError(code, message, false, "Upload a different file.");
  };

  await ctx.stage("verifying file");
  const path = await store.materialize(asset.storageKey).catch(() => null);
  if (!path) await fail("upload_missing", "The uploaded file was not received.");
  const size = await store.size(asset.storageKey);
  if (size > UPLOAD_LIMITS.maxBytes) await fail("too_large", "File exceeds the upload limit.");
  const hash = await sha256File(path!);
  const head = await magic(path!, 64);
  const media: Record<string, unknown> = {};
  const derived: Record<string, unknown> = {};
  let kind = asset.kind;

  if (kind === "image" || kind === "svg") {
    const img = sniffImage(head);
    if (img) {
      kind = "image";
      const p = await probeMedia(path!).catch(() => null);
      if (!p?.video) await fail("invalid_image", "The image could not be decoded.");
      media.width = p!.video!.width;
      media.height = p!.video!.height;
      media.format = img;
    } else if (/<svg|<\?xml/i.test(head.toString("utf8"))) {
      kind = "svg";
      await ctx.stage("rasterising SVG");
      const out = join(ctx.workDir, "raster.png");
      const dim = await rasterizeSvg(path!, out);
      const rasterKey = `${asset.storageKey}.raster.png`;
      await store.putFile(rasterKey, out, "image/png");
      derived.rasterKey = rasterKey;
      Object.assign(media, dim, { format: "svg", rasterized: true });
    } else {
      await fail("invalid_image", "The file's contents are not a supported image (PNG, JPEG, WebP, GIF or SVG).");
    }
  } else if (kind === "video" || kind === "audio") {
    await ctx.stage("probing media");
    const p = await probeMedia(path!).catch(() => null);
    if (!p || (!p.video && !p.audio)) await fail("invalid_media", "The file contains no decodable audio or video.");
    if (p!.video) kind = "video";
    else kind = "audio";
    const dur = p!.durationSec ?? 0;
    if (kind === "video" && dur > UPLOAD_LIMITS.maxSourceSec) await fail("too_long", `Source recordings are limited to ${UPLOAD_LIMITS.maxSourceSec / 60} minutes.`);
    Object.assign(media, {
      durationSec: dur,
      width: p!.video?.width,
      height: p!.video?.height,
      fps: p!.video?.fps,
      hasAudio: !!p!.audio,
      codecs: { video: p!.video?.codec, audio: p!.audio?.codec },
      sampleRate: p!.audio?.sampleRate,
      channels: p!.audio?.channels,
    });
    if (kind === "video") {
      await ctx.stage("creating thumbnail");
      const thumb = join(ctx.workDir, "thumb.jpg");
      await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-y", "-ss", String(Math.min(1, dur / 2)), "-i", path!, "-frames:v", "1", "-vf", "scale=480:-2", thumb], { timeoutMs: 60_000 });
      const thumbKey = `${asset.storageKey}.thumb.jpg`;
      await store.putFile(thumbKey, thumb, "image/jpeg");
      derived.thumbKey = thumbKey;
      // Preview proxy for large or non-H.264 sources; the original is kept for export.
      if ((p!.video!.width > 1280 || p!.video!.codec !== "h264") && process.env.SKIP_PROXIES !== "1") {
        await ctx.stage("creating preview proxy");
        const proxy = join(ctx.workDir, "proxy.mp4");
        await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-y", "-i", path!, "-vf", "scale='min(1280,iw)':-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", "30", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", proxy], {
          timeoutMs: 1_800_000,
          signal: ctx.signal,
        });
        const proxyKey = `${asset.storageKey}.proxy.mp4`;
        await store.putFile(proxyKey, proxy, "video/mp4");
        derived.proxyKey = proxyKey;
      }
    }
    if (p!.audio) {
      await ctx.stage("computing waveform");
      derived.peaks = await audioPeaks(path!);
    }
  } else if (kind === "font") {
    const f = sniffFont(head);
    if (!f) await fail("invalid_font", "The file is not a TTF, OTF, WOFF or WOFF2 font.");
    const family = (await fontFamily(path!)) ?? asset.originalName.replace(/\.[^.]+$/, "").replace(/[-_](regular|bold|medium|light)$/i, "");
    const weightHint = /black|heavy/i.test(asset.originalName) ? 900 : /bold/i.test(asset.originalName) ? 700 : /semi/i.test(asset.originalName) ? 600 : /medium/i.test(asset.originalName) ? 500 : /light/i.test(asset.originalName) ? 300 : 400;
    Object.assign(media, { font: { family, weight: Number(ctx.job.input.fontWeight ?? weightHint), style: /italic/i.test(asset.originalName) ? "italic" : "normal", format: f } });
  }

  const dup = await findDuplicate(db, ctx.job.workspaceId, hash, assetId);
  if (dup) {
    await db
      .update(schema.assets)
      .set({ status: "failed", error: "duplicate", contentHash: null, provenance: sql`${schema.assets.provenance} || ${JSON.stringify({ duplicateOf: dup.id })}::jsonb` })
      .where(eq(schema.assets.id, assetId));
    await store.delete(asset.storageKey);
    return { assetId: dup.id, duplicateOf: dup.id, deduplicated: true };
  }

  await db.update(schema.assets).set({ status: "ready", kind, contentHash: hash, bytes: size, media, derived, error: null }).where(eq(schema.assets.id, assetId));
  await writeFile(join(ctx.workDir, "ok"), "");
  return { assetId, kind, media };
};
