import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { GraphicsUnavailableError, type GraphicsCompileInfo, type GraphicsFragment, type StagedFont } from "@vs/compositor";
import type { GraphicsLayer } from "@vs/domain";
import { bundleRuntime } from "./build";
import { findComponent } from "./catalog";
import { redrawAvailable, redrawRuntime } from "./redraw";

const require = createRequire(import.meta.url);
const here = dirname(new URL(import.meta.url).pathname);

export interface GraphicsCompilerLike {
  compile: (layer: GraphicsLayer, info: GraphicsCompileInfo) => GraphicsFragment;
  prepare?: (layers: { sceneId: string; layer: GraphicsLayer }[], bundleDir: string) => Promise<void>;
  versions: Record<string, string>;
}

export interface GraphicsCapabilities {
  skia: { available: boolean; version: string; binding: "canvaskit-wasm"; surface: "cpu-raster" };
  redraw: { available: boolean; version: string | null; checksum: string | null; reason?: string };
}

export async function graphicsCapabilities(): Promise<GraphicsCapabilities> {
  const r = await redrawAvailable();
  return {
    skia: { available: true, version: "canvaskit-wasm@0.42.0", binding: "canvaskit-wasm", surface: "cpu-raster" },
    redraw: { available: r.available, version: r.version, checksum: r.checksum, reason: r.reason },
  };
}

function pickFont(fonts: StagedFont[], family: string, weight = 700): string | undefined {
  const same = fonts.filter((f) => f.family === family);
  const pool = same.length ? same : fonts;
  return pool.sort((a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight))[0]?.file;
}

function specScript(spec: Record<string, unknown>): string {
  // JSON inside a <script>: escape "<" so text params can never close the tag.
  return `window.__vsGraphics=(window.__vsGraphics||[]);window.__vsGraphics.push(${JSON.stringify(spec).replace(/</g, "\\u003c")});`;
}

/**
 * Build a compiler for the backends a document needs. Throws GraphicsUnavailableError
 * when a required backend is not usable on this worker (never a blank layer).
 */
export async function createGraphicsCompiler(backends: Set<"skia" | "redraw">, cacheDir: string): Promise<GraphicsCompilerLike> {
  await mkdir(cacheDir, { recursive: true });
  const files: { path: string; source: string }[] = [];
  const versions: Record<string, string> = {};
  if (backends.has("skia")) {
    const ckDir = dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
    const runtime = await bundleRuntime(join(here, "runtime", "skia-runtime.ts"), join(cacheDir, "skia"), { external: ["canvaskit-wasm"] });
    files.push({ path: "vendor/canvaskit.js", source: join(ckDir, "canvaskit.js") }, { path: "vendor/canvaskit.wasm", source: join(ckDir, "canvaskit.wasm") }, { path: "vendor/vs-skia.js", source: runtime });
    versions.skia = `canvaskit-wasm@0.42.0; runtime ${runtime.split("/").pop()}`;
  }
  if (backends.has("redraw")) {
    const r = await redrawRuntime(cacheDir);
    if (!r.ok) throw new GraphicsUnavailableError(r.reason);
    files.push({ path: "vendor/vs-redraw.js", source: r.runtime });
    versions.redraw = `redraw@${r.version} sha256:${r.checksum.slice(0, 12)}; runtime ${r.runtime.split("/").pop()}`;
  }

  return {
    versions,
    compile(layer, info) {
      const def = findComponent(layer.component, layer.componentVersion);
      if (!def || def.backend !== layer.backend) throw new GraphicsUnavailableError(`Unknown ${layer.backend} component ${layer.component} v${layer.componentVersion}.`);
      if (!backends.has(layer.backend)) throw new GraphicsUnavailableError(`The ${layer.backend} backend is not available on this worker.`);
      const w = Math.max(2, Math.round(info.box.width));
      const h = Math.max(2, Math.round(info.box.height));
      const assetUrls: Record<string, string> = {};
      for (const p of def.params.filter((x) => x.kind === "asset")) {
        const id = String(layer.params[p.name] ?? "");
        if (!id) continue;
        const file = info.assetFile(id);
        if (!file) throw new GraphicsUnavailableError(`Asset for ${def.name} "${p.name}" is not staged.`);
        assetUrls[p.name] = file;
      }
      const fontUrl = pickFont(info.fonts, info.brand.fonts.heading.family, info.brand.fonts.heading.weight);
      if (!fontUrl) throw new GraphicsUnavailableError("No font is staged for graphics text.");
      const unit = Math.min(info.width, info.height) / 1080;
      const params = { ...Object.fromEntries(def.params.map((p) => [p.name, p.default])), ...layer.params };
      if (typeof params.size === "number") params.size = params.size * unit;
      const spec = { id: layer.id, backend: layer.backend, component: def.id, version: def.version, params, unit, startSec: info.sceneStartSec, durationSec: info.sceneDurationSec, width: w, height: h, seed: layer.seed, assetUrls, fontUrl };
      return {
        html: `<canvas id="gfx-${layer.id}" width="${w}" height="${h}" style="width:100%;height:100%;display:block"></canvas>`,
        script: specScript(spec),
        scriptSrcs: layer.backend === "skia" ? ["vendor/canvaskit.js", "vendor/vs-skia.js"] : ["vendor/vs-redraw.js"],
        files,
      };
    },
  };
}

export async function dirSize(d: string): Promise<number> {
  if (!existsSync(d)) return 0;
  let n = 0;
  for (const f of await readdir(d)) n += (await stat(join(d, f))).size;
  return n;
}
