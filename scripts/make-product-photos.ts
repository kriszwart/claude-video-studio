/**
 * Sample catalog photos for the P6 spec-ad template (SAMPLE, CC0): a fictional "Tidewave"
 * water bottle drawn with CSS in three colourways, rendered to PNG. Not a real product.
 */
import { join } from "node:path";
import { chromium } from "playwright-core";
import { resolveChromePath } from "@vs/rendering";

const out = join(import.meta.dirname, "..", "fixtures", "sample");
const shots = [
  { name: "product-bottle-teal", body: "#0f766e", cap: "#e2e8f0", bg: "linear-gradient(160deg,#ecfeff,#99f6e4)", angle: -8 },
  { name: "product-bottle-coral", body: "#e8505b", cap: "#1f2937", bg: "linear-gradient(160deg,#fff7ed,#fecaca)", angle: 6 },
  { name: "product-bottle-night", body: "#1e293b", cap: "#f59e0b", bg: "linear-gradient(160deg,#e2e8f0,#94a3b8)", angle: 0 },
];
const browser = await chromium.launch({ executablePath: await resolveChromePath() });
const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
for (const s of shots) {
  await page.setContent(`<html><body style="margin:0"><div style="position:relative;width:1080px;height:1350px;background:${s.bg};overflow:hidden;font-family:Arial">
  <div style="position:absolute;left:340px;top:1180px;width:400px;height:40px;border-radius:50%;background:rgba(0,0,0,.18);filter:blur(8px)"></div>
  <div style="position:absolute;left:390px;top:230px;width:300px;height:960px;transform:rotate(${s.angle}deg);transform-origin:50% 100%">
    <div style="position:absolute;left:95px;top:0;width:110px;height:110px;border-radius:24px 24px 10px 10px;background:${s.cap}"></div>
    <div style="position:absolute;left:70px;top:95px;width:160px;height:40px;border-radius:12px;background:${s.cap};filter:brightness(.85)"></div>
    <div style="position:absolute;left:0;top:125px;width:300px;height:835px;border-radius:120px 120px 60px 60px;background:linear-gradient(90deg,rgba(255,255,255,.18),transparent 30%,transparent 70%,rgba(0,0,0,.25)),${s.body}"></div>
    <div style="position:absolute;left:0;top:520px;width:300px;text-align:center;color:rgba(255,255,255,.92);font-weight:700;font-size:40px;letter-spacing:.12em">TIDEWAVE</div>
    <div style="position:absolute;left:0;top:575px;width:300px;text-align:center;color:rgba(255,255,255,.7);font-size:22px">750 ml</div>
  </div>
  <div style="position:absolute;left:28px;bottom:20px;font-size:22px;color:rgba(0,0,0,.45)">SAMPLE product photo · fictional</div></div></body></html>`);
  await page.screenshot({ path: join(out, `${s.name}.png`) });
  console.log("wrote", s.name);
}
await browser.close();
process.exit(0);
