import { createHash } from "node:crypto";
import { copyFile, link, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { compileComposition, type CompileContext, type GraphicsFragment, type StagedAsset, type StagedFont } from "@vs/compositor";
import { computeTimeline, resolveAudio, stableStringify, type Layer, type ProjectDocument } from "@vs/domain";
import { FFMPEG, runOk } from "./exec";
import { mixAudio, type MixInput, type MixReport } from "./mix";
import { verifyVideo, type VerificationReport } from "./verify";

const require = createRequire(import.meta.url);

export interface ResolvedAssetFile {
  id: string;
  path: string;
  kind: StagedAsset["kind"] | "document" | "other" | "render";
  contentHash: string;
  media: { width?: number; height?: number; durationSec?: number; hasAudio?: boolean };
  /** Uploaded fonts only. */
  font?: { family: string; weight: number; style?: "normal" | "italic" };
}

export type RenderStage = "staging" | "mixing" | "compiling" | "rendering" | "encoding" | "verifying";

export interface GraphicsCompiler {
  compile: NonNullable<CompileContext["graphics"]>;
  /** Called before compilation so adapters can pre-render or stage runtime files. */
  prepare?: (layers: { sceneId: string; layer: Extract<Layer, { kind: "graphics" }> }[], bundleDir: string) => Promise<void>;
  versions: Record<string, string>;
}

export interface RenderRequest {
  doc: ProjectDocument;
  assets: ReadonlyMap<string, ResolvedAssetFile>;
  workDir: string;
  output: string;
  scale: number;
  quality: "draft" | "standard" | "high";
  signal?: AbortSignal;
  onProgress?: (stage: RenderStage, fraction: number | null, message: string) => void | Promise<void>;
  graphics?: GraphicsCompiler;
  /** Additional audio (e.g. talking-head source segments mapped through the EDL). */
  extraMix?: MixInput[];
  workers?: number;
}

export interface RenderResult {
  output: string;
  bundleDir: string;
  bundleHash: string;
  manifest: Record<string, unknown>;
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  mix: MixReport;
  verification: VerificationReport;
  warnings: string[];
  timingsMs: Record<string, number>;
}

export const RENDERER_VERSIONS = {
  "@hyperframes/producer": "0.8.90",
  gsap: "3.15.0",
  compositor: "video-studio-compositor/1",
};

export function defaultChromePath(): string | undefined {
  if (process.env.HYPERFRAMES_CHROME_PATH) return process.env.HYPERFRAMES_CHROME_PATH;
  return undefined;
}

async function findPlaywrightHeadlessShell(): Promise<string | undefined> {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  try {
    const dirs = (await readdir(root)).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
    for (const d of dirs) {
      const p = join(root, d, "chrome-linux", "headless_shell");
      if (await exists(p)) return p;
    }
  } catch {
    /* not present */
  }
  return undefined;
}

export async function resolveChromePath(): Promise<string | undefined> {
  return defaultChromePath() ?? (await findPlaywrightHeadlessShell());
}

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function linkOrCopy(src: string, dst: string) {
  try {
    await link(src, dst);
  } catch {
    await copyFile(src, dst);
  }
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Bundled @fontsource families: family → package directory. */
const BUNDLED: Record<string, string> = {
  Inter: "@fontsource/inter",
  "Space Grotesk": "@fontsource/space-grotesk",
  "DM Serif Display": "@fontsource/dm-serif-display",
  Caveat: "@fontsource/caveat",
  "Bebas Neue": "@fontsource/bebas-neue",
};

async function stageBundledFonts(families: string[], fontsDir: string): Promise<StagedFont[]> {
  const out: StagedFont[] = [];
  for (const family of new Set(families)) {
    const pkg = BUNDLED[family];
    if (!pkg) continue;
    const pkgDir = dirname(require.resolve(`${pkg}/package.json`));
    const slug = pkg.split("/")[1]!;
    for (const w of [300, 400, 500, 600, 700, 800]) {
      const file = join(pkgDir, "files", `${slug}-latin-${w}-normal.woff2`);
      if (!(await exists(file))) continue;
      const name = `${slug}-${w}.woff2`;
      await linkOrCopy(file, join(fontsDir, name));
      out.push({ family, weight: w, file: `fonts/${name}` });
    }
  }
  return out;
}

/**
 * Render one immutable project revision to a verified MP4.
 * The bundle directory is self-contained: no network access is needed at render time.
 */
export async function renderProject(req: RenderRequest): Promise<RenderResult> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (k: string, since: number) => (timings[k] = Date.now() - since);
  const progress = async (stage: RenderStage, fraction: number | null, message: string) => {
    if (req.signal?.aborted) throw new Error("canceled");
    await req.onProgress?.(stage, fraction, message);
  };
  const { doc } = req;
  const bundleDir = join(req.workDir, "bundle");
  await rm(bundleDir, { recursive: true, force: true });
  await mkdir(join(bundleDir, "assets"), { recursive: true });
  await mkdir(join(bundleDir, "fonts"), { recursive: true });
  await mkdir(join(bundleDir, "vendor"), { recursive: true });
  await mkdir(join(bundleDir, "audio"), { recursive: true });

  // 1. Stage assets locally.
  await progress("staging", null, "Staging assets");
  let ts = Date.now();
  const staged = new Map<string, StagedAsset>();
  const assetHashes: Record<string, string> = {};
  for (const [id, a] of req.assets) {
    if (a.kind !== "image" && a.kind !== "svg" && a.kind !== "video" && a.kind !== "audio" && a.kind !== "font") continue;
    const ext = extname(a.path).toLowerCase() || (a.kind === "svg" ? ".svg" : "");
    const rel = `assets/${id}${ext}`;
    await linkOrCopy(a.path, join(bundleDir, rel));
    staged.set(id, { file: rel, kind: a.kind, width: a.media.width, height: a.media.height, durationSec: a.media.durationSec, hasAudio: a.media.hasAudio });
    assetHashes[id] = a.contentHash;
  }
  const uploadedFonts: StagedFont[] = [...req.assets.values()]
    .filter((a) => a.kind === "font" && a.font)
    .map((a) => ({ family: a.font!.family, weight: a.font!.weight, style: a.font!.style, file: staged.get(a.id)!.file }));
  const fontFamilies = [doc.brand.fonts.heading.family, doc.brand.fonts.body.family].filter((f) => !uploadedFonts.some((u) => u.family === f));
  const bundledFonts = await stageBundledFonts(fontFamilies, join(bundleDir, "fonts"));
  const gsapSrc = join(dirname(require.resolve("gsap/package.json")), "dist", "gsap.min.js");
  await linkOrCopy(gsapSrc, join(bundleDir, "vendor", "gsap.min.js"));
  mark("staging", ts);

  // 2. Mix audio on the shared timeline.
  await progress("mixing", null, "Mixing audio");
  ts = Date.now();
  const timeline = computeTimeline(doc);
  const media = (id: string) => req.assets.get(id)?.media.durationSec;
  const resolved = resolveAudio(doc, timeline, media);
  const mixInputs: MixInput[] = resolved
    .filter((r) => req.assets.has(r.track.assetId))
    .map((r) => ({
      id: r.track.id,
      kind: r.track.kind,
      file: req.assets.get(r.track.assetId)!.path,
      startFrame: r.startFrame,
      durationFrames: r.durationFrames,
      sourceInSec: r.track.sourceInSec,
      gainDb: r.track.gainDb,
      fadeInFrames: r.track.fadeInFrames,
      fadeOutFrames: Math.min(r.track.fadeOutFrames, r.durationFrames),
      duck: r.track.duck,
    }));
  // Audible video layers (unmuted) contribute their soundtrack for the scene they occupy.
  doc.scenes.forEach((scene, i) => {
    const st = timeline.scenes[i]!;
    for (const layer of scene.layers) {
      if (layer.kind !== "video" || layer.muted || layer.hidden || !layer.assetId) continue;
      const a = req.assets.get(layer.assetId);
      if (!a?.media.hasAudio) continue;
      const avail = a.media.durationSec !== undefined ? Math.max(0, (layer.sourceOutSec ?? a.media.durationSec) - layer.sourceInSec) : st.duration / doc.format.fps;
      mixInputs.push({
        id: `${scene.id}-${layer.id}`,
        kind: "source",
        file: a.path,
        startFrame: st.start,
        durationFrames: Math.min(st.duration, Math.floor(avail * doc.format.fps)),
        sourceInSec: layer.sourceInSec,
        gainDb: 0,
        fadeInFrames: 1,
        fadeOutFrames: 1,
      });
    }
  });
  if (req.extraMix) mixInputs.push(...req.extraMix);
  const mixFile = join(bundleDir, "audio", "mix.wav");
  const mix = await mixAudio(mixInputs, { fps: doc.format.fps, totalFrames: timeline.totalFrames, output: mixFile, signal: req.signal });
  mark("mixing", ts);

  // 3. Compile the composition.
  await progress("compiling", null, "Compiling composition");
  ts = Date.now();
  if (req.graphics?.prepare) {
    const gl = doc.scenes.flatMap((s) => s.layers.filter((l): l is Extract<Layer, { kind: "graphics" }> => l.kind === "graphics" && !l.hidden).map((layer) => ({ sceneId: s.id, layer })));
    if (gl.length) await req.graphics.prepare(gl, bundleDir);
  }
  const compileCtx = {
    scale: req.scale,
    assets: staged,
    fonts: [...uploadedFonts, ...bundledFonts],
    gsapFile: "vendor/gsap.min.js",
    graphics: req.graphics?.compile,
  };
  // The render bundle carries no <audio>: HyperFrames captures frames and the verified
  // mix is muxed afterwards (measured: HF's own muxing shifted integrated loudness by
  // about -1.3 LU on our fixtures). The preview page embeds the same mix for playback.
  const compiled = compileComposition(doc, compileCtx);
  const preview = compileComposition(doc, { ...compileCtx, audioMix: { file: "audio/mix.wav" } });
  await writeFile(join(bundleDir, "index.html"), compiled.html);
  await writeFile(join(bundleDir, "preview.html"), preview.html);
  for (const f of compiled.extraFiles) {
    await mkdir(dirname(join(bundleDir, f.path)), { recursive: true });
    await linkOrCopy(f.source, join(bundleDir, f.path));
  }
  const mixHash = await sha256File(mixFile);
  const htmlHash = createHash("sha256").update(compiled.html).digest("hex");
  const manifest = {
    ...compiled.manifest,
    htmlHash,
    mixHash,
    assetHashes,
    fontFiles: [...uploadedFonts, ...bundledFonts].map((f) => f.file).sort(),
    renderer: RENDERER_VERSIONS,
    graphics: req.graphics?.versions ?? {},
    quality: req.quality,
  };
  const bundleHash = createHash("sha256").update(stableStringify(manifest)).digest("hex");
  await writeFile(join(bundleDir, "bundle.json"), JSON.stringify({ bundleHash, ...manifest }, null, 2));
  mark("compiling", ts);

  // 4. Render frames + encode with HyperFrames.
  ts = Date.now();
  await progress("rendering", 0, "Capturing frames");
  const videoOnly = join(req.workDir, "video-only.mp4");
  await renderWithHyperFrames(bundleDir, videoOnly, {
    quality: req.quality,
    workers: req.workers ?? Number(process.env.RENDER_WORKERS ?? 2),
    signal: req.signal,
    onProgress: async (pct, msg, stage) => {
      await progress(stage === "encoding" ? "encoding" : "rendering", pct === null ? null : pct / 100, msg);
    },
  });
  mark("render", ts);
  ts = Date.now();
  await progress("encoding", null, "Muxing audio");
  await runOk(
    FFMPEG,
    ["-hide_banner", "-nostdin", "-y", "-i", videoOnly, "-i", mixFile, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", (compiled.totalFrames / compiled.fps).toFixed(6), "-movflags", "+faststart", req.output],
    { signal: req.signal, timeoutMs: 600_000 },
  );
  await rm(videoOnly, { force: true });
  mark("mux", ts);

  // 5. Verify.
  ts = Date.now();
  await progress("verifying", null, "Verifying output");
  const verification = await verifyVideo(
    req.output,
    { width: compiled.width, height: compiled.height, fps: compiled.fps, totalFrames: compiled.totalFrames, requireAudio: true },
    req.signal,
  );
  mark("verify", ts);
  timings.total = Date.now() - t0;

  return {
    output: req.output,
    bundleDir,
    bundleHash,
    manifest,
    width: compiled.width,
    height: compiled.height,
    fps: compiled.fps,
    totalFrames: compiled.totalFrames,
    mix,
    verification,
    warnings: compiled.warnings,
    timingsMs: timings,
  };
}

export interface HfRenderOptions {
  quality: "draft" | "standard" | "high";
  workers: number;
  signal?: AbortSignal;
  onProgress?: (percent: number | null, message: string, stage: string) => void | Promise<void>;
}

/** Thin adapter over the pinned @hyperframes/producer API (0.8.90). */
export async function renderWithHyperFrames(projectDir: string, outputPath: string, opts: HfRenderOptions): Promise<void> {
  const producer = await import("@hyperframes/producer");
  const chromePath = await resolveChromePath();
  const engineConfig = producer.resolveConfig({ chromePath, browserGpuMode: "software", concurrency: opts.workers } as never);
  const request = producer.createRenderRequest({
    projectDir,
    outputPath,
    engineConfig,
    options: { fps: { num: 30, den: 1 }, quality: opts.quality, format: "mp4", workers: opts.workers },
  } as never);
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const job = producer.createRenderJob(producer.renderConfigFromRequest(request as never, { logger: silent } as never));
  let lastPct = -1;
  await producer.executeRenderJob(
    job,
    projectDir,
    outputPath,
    async (j: { progress?: number; currentStage?: string; framesRendered?: number; totalFrames?: number }, msg?: string) => {
      const pct = typeof j.progress === "number" ? Math.floor(j.progress) : null;
      if (pct !== lastPct) {
        lastPct = pct ?? -1;
        const stage = /encod|assembl/i.test(msg ?? j.currentStage ?? "") ? "encoding" : "rendering";
        await opts.onProgress?.(pct, msg ?? "", stage);
      }
    },
    opts.signal,
  );
  const outcome = (job as { outcome?: string }).outcome;
  if (outcome !== "completed" && outcome !== "completed_with_warnings") {
    throw new Error(`HyperFrames render did not complete (${outcome ?? "unknown"})`);
  }
}

export async function shutdownRenderer(): Promise<void> {
  const engine = await import("@hyperframes/engine");
  await engine.closeBrowserPool();
}

export type { GraphicsFragment };
