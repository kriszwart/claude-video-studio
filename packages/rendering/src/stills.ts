import { chromium, type Browser } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runOk, FFMPEG } from "./exec";
import { resolveChromePath } from "./render";

export interface StillsRequest {
  bundleDir: string;
  width: number;
  height: number;
  /** Seconds on the composition timeline. */
  times: number[];
  /** Output path per time index. */
  outPath: (index: number) => string;
  signal?: AbortSignal;
  webgpu?: boolean;
  /** Called with the page before capturing (tests: e.g. simulate device loss). */
  beforeCapture?: (page: import("playwright-core").Page, index: number) => Promise<void>;
}

export interface PageReport {
  overflow: string[];
  missingFonts: string[];
  /** Text that had to shrink below 75% of its designed size to fit (layer DOM ids). */
  shrunk?: { id: string; ratio: number; px?: number }[];
  skia?: unknown;
  redraw?: unknown;
}

export interface StillsResult {
  files: string[];
  report: PageReport;
}

/**
 * Capture individual frames from a compiled bundle through the HyperFrames file
 * server, runtime and virtual-time shim — the same runtime the renderer uses —
 * so storyboard keyframes are real frames of the composition, not concept art.
 */
export async function captureStills(req: StillsRequest): Promise<StillsResult> {
  const producer = await import("@hyperframes/producer");
  const server = await producer.createFileServer({ projectDir: req.bundleDir, port: 0, preHeadScripts: [(producer as unknown as { VIRTUAL_TIME_SHIM?: string }).VIRTUAL_TIME_SHIM ?? ""].filter(Boolean), fps: { num: 30, den: 1 } } as never);
  let browser: Browser | undefined;
  try {
    const executablePath = await resolveChromePath();
    browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-color-profile=srgb", "--hide-scrollbars", ...(req.webgpu ? ["--enable-unsafe-webgpu"] : [])] });
    const page = await browser.newPage({ viewport: { width: req.width, height: req.height }, deviceScaleFactor: 1 });
    await page.goto(`${server.url}/index.html`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(() => (window as unknown as { __renderReady?: boolean }).__renderReady === true, null, { timeout: 60_000 });
    const files: string[] = [];
    for (let i = 0; i < req.times.length; i++) {
      if (req.signal?.aborted) throw new Error("canceled");
      const t = req.times[i]!;
      await req.beforeCapture?.(page, i);
      await page.evaluate(async (time) => {
        const w = window as unknown as { __hf: { seek: (t: number) => void }; __hfWaitForSeekCompletion?: () => Promise<void> };
        w.__hf.seek(time);
        await w.__hfWaitForSeekCompletion?.();
      }, t);
      await injectVideoFrames(page, req.bundleDir, t, i);
      const out = req.outPath(i);
      await page.locator("#root").screenshot({ path: out, type: out.endsWith(".png") ? "png" : "jpeg", quality: out.endsWith(".png") ? undefined : 85 });
      files.push(out);
    }
    const report = (await page.evaluate(() => {
      const w = window as unknown as { __vsReport?: PageReport; __vsSkiaReport?: unknown; __vsRedrawReport?: unknown };
      return { ...(w.__vsReport ?? { overflow: [], missingFonts: [] }), skia: w.__vsSkiaReport ?? null, redraw: w.__vsRedrawReport ?? null };
    })) as PageReport;
    return { files, report };
  } finally {
    await browser?.close();
    server.close();
  }
}

/**
 * Browsers used for capture may lack H.264 decoding, and the export path injects decoded
 * frames itself. For stills we do the same: decode the exact frame of every <video> on
 * screen with ffmpeg and paint it over the element (same box, fit and transform).
 */
async function injectVideoFrames(page: import("playwright-core").Page, bundleDir: string, time: number, index: number) {
  const vids = (await page.evaluate(`(() => {
    const t = ${time};
    return [...document.querySelectorAll("video[data-start]")].map((v, k) => {
      if (!v.id) v.id = "vs-vid-" + k;
      const start = Number(v.dataset.start || 0), dur = Number(v.dataset.duration || 1e9);
      const on = t >= start && t < start + dur;
      return on ? { id: v.id, src: v.getAttribute("src"), at: Number(v.dataset.mediaStart || 0) + (t - start) } : null;
    }).filter(Boolean);
  })()`)) as { id: string; src: string; at: number }[];
  await page.evaluate(`document.querySelectorAll("img.vs-still-frame").forEach((e) => e.remove())`);
  if (!vids.length) return;
  const dir = join(bundleDir, "_stills");
  await mkdir(dir, { recursive: true });
  for (const [k, v] of vids.entries()) {
    if (!v.src || v.src.includes("..") || /^[a-z]+:/i.test(v.src)) continue;
    const rel = `_stills/f${index}-${k}.jpg`;
    await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-ss", v.at.toFixed(3), "-i", join(bundleDir, v.src), "-frames:v", "1", "-q:v", "3", join(bundleDir, rel)], { timeoutMs: 60_000 }).catch(() => null);
    await page.evaluate(`(async () => {
      const v = document.getElementById(${JSON.stringify(v.id)});
      if (!v) return;
      const img = document.createElement("img");
      img.className = "vs-still-frame";
      img.src = ${JSON.stringify(rel)} + "?t=" + Date.now();
      const cs = getComputedStyle(v);
      img.style.cssText = v.style.cssText;
      img.style.objectFit = cs.objectFit; img.style.objectPosition = cs.objectPosition; img.style.transform = cs.transform; img.style.transformOrigin = cs.transformOrigin;
      img.style.position = "absolute"; img.style.left = v.offsetLeft + "px"; img.style.top = v.offsetTop + "px";
      img.style.width = v.offsetWidth + "px"; img.style.height = v.offsetHeight + "px"; img.style.opacity = cs.opacity; img.style.visibility = cs.visibility;
      v.insertAdjacentElement("afterend", img);
      await img.decode().catch(() => {});
    })()`);
  }
}
