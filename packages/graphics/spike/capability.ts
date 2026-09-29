/**
 * Section 27.4 capability spike, per backend:
 *  1. real 5 s / 30 fps composition with a supplied font, transparent edges, an image
 *     and animated geometry;
 *  2. out-of-order and repeated seeks compared on the same worker;
 *  3. all 150 frames captured behind the ready barrier → playable MP4 with audio;
 *  4. preview stills vs export frames at matching times;
 *  5. device loss / reinitialisation (Redraw) without corrupting the project.
 * Usage: tsx spike/capability.ts skia|redraw
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOCUMENT_SCHEMA_VERSION, ProjectDocument, type Layer } from "@vs/domain";
import { captureStills, probeMedia, renderProject, sha256File, shutdownRenderer, type ResolvedAssetFile } from "@vs/rendering";
import { DEFAULT_BRAND } from "@vs/templates";
import { createGraphicsCompiler, defaultParams, findComponent } from "../src";

const backend = (process.argv[2] ?? "skia") as "skia" | "redraw";
const scale = Number(process.argv[3] ?? 1);
const out = join(import.meta.dirname, "..", "..", "..", "artifacts", "graphics", backend);
mkdirSync(out, { recursive: true });
const fx = join(import.meta.dirname, "..", "..", "..", "fixtures", "sample");

async function asset(id: string, file: string, kind: ResolvedAssetFile["kind"]): Promise<ResolvedAssetFile> {
  const p = join(fx, file);
  const pr = await probeMedia(p);
  return { id, path: p, kind, contentHash: await sha256File(p), media: { width: pr.video?.width, height: pr.video?.height, durationSec: pr.durationSec ?? undefined, hasAudio: !!pr.audio } };
}
const assets = new Map<string, ResolvedAssetFile>([
  ["shot", await asset("shot", "tidewave-dashboard.png", "image")],
  ["music", await asset("music", "music-launch-bed.m4a", "audio")],
]);

const gfx = (id: string, component: string, slot: string, box: { x: number; y: number; w: number; h: number }, params: Record<string, number | string | boolean> = {}): Layer => {
  const def = findComponent(component, 1)!;
  return { id, kind: "graphics", slot, backend, component, componentVersion: 1, params: { ...defaultParams(def), ...params }, seed: 7, hidden: false, box };
};
const layers: Layer[] =
  backend === "skia"
    ? [
        gfx("reveal", "mask-reveal", "media", { x: 0.52, y: 0.14, w: 0.44, h: 0.62 }, { image: "shot", focalX: 0.3, focalY: 0.35, zoom: 2.4, revealSec: 2.4 }),
        gfx("diagram", "path-diagram", "overlay", { x: 0.04, y: 0.58, w: 0.44, h: 0.3 }, { steps: "Capture|Plan|Focus", color: "#e2e8f0", accent: "#22d3ee", ink: "#f8fafc", stepSec: 1.3 }),
        gfx("anno", "type-overlay", "label", { x: 0.04, y: 0.38, w: 0.44, h: 0.16 }, { text: "Skia-drawn annotation", color: "#f8fafc", accent: "#f59e0b", size: 56 }),
      ]
    : [
        gfx("sweep", "color-sweep", "decor", { x: 0.55, y: 0.1, w: 0.42, h: 0.8 }, { rings: 6, sweepSec: 3 }),
        gfx("ribbon", "ribbon", "overlay", { x: 0.02, y: 0.55, w: 0.6, h: 0.4 }, { path: "wave", width: 50, drawSec: 2.5, glow: 20 }),
        gfx("backing", "glow-backing", "label", { x: 0.05, y: 0.2, w: 0.45, h: 0.2 }, { color: "#0f172a", glowColor: "#8b8fff", feather: 28 }),
      ];

const doc = ProjectDocument.parse({
  schemaVersion: DOCUMENT_SCHEMA_VERSION,
  title: `${backend} capability spike`,
  template: { templateId: "spike", version: 1, family: "motion-reel" },
  format: { aspect: "16:9", fps: 30 },
  brand: { ...DEFAULT_BRAND, fonts: { heading: { family: "Space Grotesk", weight: 700 }, body: { family: "Inter", weight: 400 } } },
  profile: {},
  brief: {},
  scenes: [
    {
      id: "s1",
      purpose: "spike",
      recipeSlot: "spike",
      durationFrames: 150,
      layout: "presenter-full",
      background: { type: "gradient", from: "#0b1020", to: "#1d2b64", angle: 135 },
      // Graphics first, then the title, so labels sit above backing panels.
      layers: [...layers, { id: "title", kind: "text", slot: "headline", role: "headline", text: backend === "skia" ? "Skia · CanvasKit" : "Redraw · WebGPU", box: backend === "skia" ? { x: 0.04, y: 0.05, w: 0.5, h: 0.18 } : { x: 0.07, y: 0.22, w: 0.41, h: 0.16 } }],
    },
  ],
  audio: [{ id: "m", kind: "music", assetId: "music", anchor: { type: "absolute", startFrame: 0 }, fadeOutFrames: 20 }],
});

const cacheDir = join(process.env.DATA_DIR ?? "/tmp", "graphics-cache");
const t0 = Date.now();
const graphics = await createGraphicsCompiler(new Set([backend]), cacheDir);
const res = await renderProject({ doc, assets, workDir: join(out, "work"), output: join(out, "export.mp4"), scale, quality: "standard", graphics, webgpu: backend === "redraw" });
const renderMs = Date.now() - t0;
console.log("export checks:", res.verification.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}`).join(" "));

// 2 + 4 + 5: stills — out of order, repeated, and (redraw) after a simulated device loss.
const times = [3.5, 0.7, 2.0, 0.7, 3.5, 4.9, 2.0];
const stills = await captureStills({
  bundleDir: res.bundleDir,
  width: res.width,
  height: res.height,
  times,
  outPath: (i) => join(out, `still-${i}.png`),
  webgpu: backend === "redraw",
  beforeCapture:
    backend === "redraw"
      ? async (page, i) => {
          if (i === 6) await page.evaluate(() => (window as unknown as { __vsLoseRedrawDevice?: () => void }).__vsLoseRedrawDevice?.());
        }
      : undefined,
});
const md5 = (f: string) => execFileSync("md5sum", [f]).toString().split(" ")[0];
function rawRgb(f: string) {
  return execFileSync("ffmpeg", ["-v", "error", "-i", f, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 * 1024 * 1024 });
}
function diff(a: string, b: string) {
  const A = rawRgb(a);
  const B = rawRgb(b);
  let maxd = 0;
  let sum = 0;
  for (let i = 0; i < A.length; i++) {
    const d = Math.abs(A[i]! - B[i]!);
    if (d > maxd) maxd = d;
    sum += d;
  }
  return { maxAbs: maxd, meanAbs: sum / A.length };
}
const repeatSame = { "0.7s": diff(stills.files[1]!, stills.files[3]!), "3.5s": diff(stills.files[0]!, stills.files[4]!), "2.0s(after-loss)": diff(stills.files[2]!, stills.files[6]!) };
// Export frame vs preview still at matching times (lossy H.264 → compare PSNR).
function psnr(still: string, t: number) {
  const frame = join(out, `export-${t}.png`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", join(out, "export.mp4"), "-frames:v", "1", frame]);
  const r = execFileSync("ffmpeg", ["-hide_banner", "-i", frame, "-i", still, "-lavfi", "psnr", "-f", "null", "-"], { stdio: ["ignore", "pipe", "pipe"] });
  return r.toString();
}
const psnrOut: Record<string, string> = {};
for (const [i, t] of [[1, 0.7], [2, 2.0], [0, 3.5]] as const) {
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", join(out, "export.mp4"), "-frames:v", "1", join(out, `export-${t}.png`)]);
    const r = execFileSync("sh", ["-c", `ffmpeg -hide_banner -i ${join(out, `export-${t}.png`)} -i ${stills.files[i]} -lavfi psnr -f null - 2>&1 | grep -o 'average:[^ ]*'`]).toString().trim();
    psnrOut[`${t}s`] = r;
  } catch (e) {
    psnrOut[`${t}s`] = `error ${String(e).slice(0, 100)}`;
  }
}
void psnr;
const report = {
  backend,
  scale,
  resolution: `${res.width}x${res.height}`,
  versions: graphics.versions,
  renderMs,
  bundleHash: res.bundleHash,
  exportOk: res.verification.ok,
  checks: res.verification.checks,
  loudness: res.verification.loudness,
  stillTimes: times,
  stillHashes: stills.files.map(md5),
  repeatDiffs: repeatSame,
  previewVsExportPsnr: psnrOut,
  pageReport: stills.report,
};
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, checks: undefined }, null, 1));
await shutdownRenderer();
void readFileSync;
