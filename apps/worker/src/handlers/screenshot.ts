import { join } from "node:path";
import { chromium } from "playwright-core";
import { JobError } from "@vs/db";
import { resolveChromePath } from "@vs/rendering";
import { registerFile, type Handler } from "../context";
import { safeFetch, UnsafeUrlError } from "../net/safeFetch";

/** Test seam (non-production only): treat a local fixture server as public. */
function seam() {
  const trusted = process.env.NODE_ENV !== "production" ? (process.env.VS_TEST_TRUSTED_OUTPUT ?? "").split(",").filter(Boolean) : [];
  return trusted.length ? { trustAddresses: trusted.map((t) => t.split(":")[0]!), allowPorts: trusted.map((t) => Number(t.split(":")[1])) } : {};
}

const MAX_REQUESTS = 250;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

/**
 * Public website screenshot (FR-15). The page runs in a throwaway browser with no network of
 * its own (dead proxy, no service workers, WebRTC restricted); every request it makes is
 * intercepted and fetched by the SSRF-guarded fetcher, which validates and pins each address.
 * Internal addresses, odd ports and non-http(s) schemes are refused and listed in the result.
 * The stored image keeps the URL and retrieval time; public availability is not a usage right.
 */
export const captureScreenshot: Handler = async (ctx) => {
  const url = String(ctx.job.input.url ?? "");
  const width = Math.max(320, Math.min(2560, Number(ctx.job.input.width ?? 1440)));
  const height = Math.max(320, Math.min(2560, Number(ctx.job.input.height ?? 900)));
  const fullPage = ctx.job.input.fullPage === true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new JobError("invalid_url", "That isn't a valid web address.", false);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new JobError("invalid_url", "Only http(s) pages can be captured.", false);
  // Validate the top-level page before starting a browser.
  try {
    await safeFetch(u.toString(), { maxBytes: 5 * 1024 * 1024, allowedTypes: /^text\/html$|^application\/xhtml\+xml$/, signal: ctx.signal, timeoutMs: 20_000, ...seam() });
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw new JobError(e.code, e.message, e.code === "timeout", "Only public web pages can be captured. Authenticated or internal pages need an explicit, authorised capture integration.");
    throw new JobError("fetch_failed", "The page could not be loaded.", true);
  }

  await ctx.stage("capturing page");
  const blocked: { url: string; reason: string }[] = [];
  let requests = 0;
  let bytes = 0;
  const browser = await chromium.launch({
    executablePath: await resolveChromePath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--proxy-server=127.0.0.1:9", "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-background-networking", "--disable-component-update", "--no-first-run", "--hide-scrollbars"],
  });
  try {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block", acceptDownloads: false, javaScriptEnabled: true, deviceScaleFactor: 1 });
    await context.route("**/*", async (route) => {
      const req = route.request();
      const target = req.url();
      if (target.startsWith("data:") || target.startsWith("blob:")) return route.continue();
      if (++requests > MAX_REQUESTS || bytes > MAX_TOTAL_BYTES) {
        blocked.push({ url: target.slice(0, 200), reason: "request budget exhausted" });
        return route.abort("blockedbyclient");
      }
      if (req.method() !== "GET") {
        blocked.push({ url: target.slice(0, 200), reason: `${req.method()} not allowed` });
        return route.abort("blockedbyclient");
      }
      try {
        const r = await safeFetch(target, { maxBytes: 15 * 1024 * 1024, allowedTypes: /.*/, signal: ctx.signal, timeoutMs: 15_000, ...seam() });
        bytes += r.body.length;
        return route.fulfill({ status: r.status, contentType: r.contentType || "application/octet-stream", body: r.body });
      } catch (e) {
        blocked.push({ url: target.slice(0, 200), reason: e instanceof UnsafeUrlError ? e.code : "fetch_failed" });
        return route.abort("blockedbyclient");
      }
    });
    await context.routeWebSocket(/.*/, (ws) => {
      blocked.push({ url: ws.url().slice(0, 200), reason: "websocket not allowed" });
      void ws.close();
    });
    const page = await context.newPage();
    await page.goto(u.toString(), { waitUntil: "load", timeout: 45_000 }).catch((e) => {
      throw new JobError("capture_failed", `The page didn't finish loading: ${String(e).slice(0, 160)}`, true);
    });
    await page.waitForTimeout(800); // let late layout settle (fonts/images already loaded at "load")
    const out = join(ctx.workDir, "screenshot.png");
    await page.screenshot({ path: out, fullPage, type: "png", ...(fullPage ? {} : { clip: { x: 0, y: 0, width, height } }) });
    const title = (await page.title().catch(() => "")).slice(0, 120);
    await ctx.stage("storing");
    const host = u.hostname.replace(/[^a-z0-9.-]/gi, "");
    const asset = await registerFile(ctx.job.workspaceId, out, {
      kind: "image",
      originalName: `screenshot-${host}.png`,
      mime: "image/png",
      provenance: { source: "screenshot", url: u.toString(), retrievedAt: new Date().toISOString(), title, viewport: { width, height, fullPage }, requests, blockedRequests: blocked, license: "unknown — public availability is not a usage right; confirm rights before publishing" },
    });
    return { assetId: asset.id, title, requests, blocked };
  } finally {
    await browser.close();
  }
};
