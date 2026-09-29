import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate } from "@vs/templates";
import { probeMedia, renderProject, sha256File, shutdownRenderer, type ResolvedAssetFile } from "../src";

const fx = join(import.meta.dirname, "../../../fixtures/sample");
const aspect = (process.argv[2] ?? "16:9") as "16:9" | "9:16" | "1:1";
const scale = Number(process.argv[3] ?? 0.5);
const files: Record<string, [string, ResolvedAssetFile["kind"]]> = {
  shot1: ["tidewave-dashboard.png", "image"],
  shot2: ["tidewave-insights.png", "image"],
  shot3: ["tidewave-mobile.png", "image"],
  logo: ["logo-tidewave.png", "image"],
  music: ["music-launch-bed.m4a", "audio"],
};
const assets = new Map<string, ResolvedAssetFile>();
for (const [id, [f, kind]] of Object.entries(files)) {
  const p = join(fx, f);
  const pr = await probeMedia(p);
  assets.set(id, { id, path: p, kind, contentHash: await sha256File(p), media: { width: pr.video?.width, height: pr.video?.height, durationSec: pr.durationSec ?? undefined, hasAudio: !!pr.audio } });
}
let n = 0;
const doc = instantiateTemplate(BUILTIN_TEMPLATES[0]!, {
  title: "Tidewave launch (sample)",
  aspect,
  brand: { ...DEFAULT_BRAND, name: "Tidewave", logoAssetId: "logo", colors: { ...DEFAULT_BRAND.colors, primary: "#0891b2", secondary: "#1e1b4b", accent: "#22d3ee" } },
  inputs: {
    productName: "Tidewave",
    promise: "Plans your day around deep work, automatically.",
    problem: "Your calendar decides your day. It shouldn't.",
    benefits: ["Protects two focus blocks every day", "Moves meetings without the back-and-forth", "Weekly insight into where time went"],
    screenshots: ["shot1", "shot2", "shot3"],
    logo: "logo",
    cta: "Try Tidewave free",
    destinationUrl: "tidewave.example",
    music: "music",
    audience: "For busy product teams",
  },
  newId: (p) => `${p}${++n}`,
});
const work = `/tmp/e2e-${aspect.replace(":", "x")}`;
mkdirSync(work, { recursive: true });
const res = await renderProject({
  doc, assets, workDir: work, output: join(work, "out.mp4"), scale, quality: "draft",
  onProgress: (s, f, m) => { if (f === null || Math.round(f * 100) % 25 === 0) console.log(s, f === null ? "" : Math.round(f * 100) + "%", m); },
});
console.log(JSON.stringify({ ok: res.verification.ok, checks: res.verification.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`), mix: res.mix, warnings: res.warnings, timings: res.timingsMs, hash: res.bundleHash }, null, 1));
await shutdownRenderer();
