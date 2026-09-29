/** Small, fast Redraw harness: renders ribbon variants to PNG for visual debugging. */
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { redrawRuntime } from "../src/redraw";

const dir = "/tmp/ribbon-harness";
mkdirSync(join(dir, "vendor"), { recursive: true });
const rt = await redrawRuntime(join(process.env.DATA_DIR ?? "/tmp", "graphics-cache"));
if (!rt.ok) throw new Error(rt.reason);
cpSync(rt.runtime, join(dir, "vendor", "vs-redraw.js"));
const variants = JSON.parse(process.argv[2] ?? '[{"width":60,"glow":0},{"width":60,"glow":20},{"width":20,"glow":0}]') as Record<string, unknown>[];
const specs = variants.map((p, i) => ({ id: `v${i}`, backend: "redraw", component: "ribbon", version: 1, params: { path: "wave", colors: "#3FCEBC,#5F96E7,#DE589F,#FAEC54", drawSec: 0.01, ...p }, startSec: 0, durationSec: 5, width: 480, height: 270, seed: 1 }));
writeFileSync(
  join(dir, "index.html"),
  `<!doctype html><html><body style="margin:0;background:#101426">${specs.map((s) => `<canvas id="gfx-${s.id}" width="480" height="270" style="display:block;border-bottom:1px solid #333"></canvas>`).join("")}
<script>window.__vsGraphics=${JSON.stringify(specs)};</script><script src="vendor/vs-redraw.js"></script></body></html>`,
);
const server = createServer((req, res) => {
  const f = join(dir, (req.url ?? "/").split("?")[0] === "/" ? "index.html" : req.url!.split("?")[0]!);
  try {
    const b = readFileSync(f);
    res.writeHead(200, { "Content-Type": f.endsWith(".js") ? "text/javascript" : "text/html" });
    res.end(b);
  } catch {
    res.writeHead(404).end();
  }
}).listen(8911);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell", args: ["--enable-unsafe-webgpu", "--no-sandbox"] });
const page = await b.newPage({ viewport: { width: 480, height: 280 * specs.length } });
page.on("console", (m) => console.log("console:", m.text()));
await page.goto("http://localhost:8911/");
await page.waitForFunction("window.__vsRedrawReport && (window.__vsRedrawReport.frames >= 1 || window.__vsRedrawReport.errors.length > 0)", null, { timeout: 180_000 });
await page.evaluate("new Promise((resolve) => window.dispatchEvent(new CustomEvent('hf-seek', { detail: { time: 2, waitUntil: (p) => p.then(() => resolve()) } })))");
console.log(JSON.stringify(await page.evaluate("window.__vsRedrawReport")));
await page.screenshot({ path: "/tmp/ribbon.png" });
await b.close();
server.close();
