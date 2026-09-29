import { chromium, type Browser } from "playwright-core";
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
}

export interface PageReport {
  overflow: string[];
  missingFonts: string[];
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
    browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-color-profile=srgb", "--hide-scrollbars"] });
    const page = await browser.newPage({ viewport: { width: req.width, height: req.height }, deviceScaleFactor: 1 });
    await page.goto(`${server.url}/index.html`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(() => (window as unknown as { __renderReady?: boolean }).__renderReady === true, null, { timeout: 60_000 });
    const files: string[] = [];
    for (let i = 0; i < req.times.length; i++) {
      if (req.signal?.aborted) throw new Error("canceled");
      const t = req.times[i]!;
      await page.evaluate(async (time) => {
        const w = window as unknown as { __hf: { seek: (t: number) => void }; __hfWaitForSeekCompletion?: () => Promise<void> };
        w.__hf.seek(time);
        await w.__hfWaitForSeekCompletion?.();
      }, t);
      const out = req.outPath(i);
      await page.locator("#root").screenshot({ path: out, type: out.endsWith(".png") ? "png" : "jpeg", quality: out.endsWith(".png") ? undefined : 85 });
      files.push(out);
    }
    const report = (await page.evaluate(() => (window as unknown as { __vsReport?: PageReport }).__vsReport ?? { overflow: [], missingFonts: [] })) as PageReport;
    return { files, report };
  } finally {
    await browser?.close();
    server.close();
  }
}
