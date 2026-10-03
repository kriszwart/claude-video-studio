import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Bundle a browser runtime with esbuild, named by the hash of the bundled output. Hashing the
 * output (not the entry file) covers every imported module, so a change anywhere in the runtime's
 * imports gives a new file name, and caches keyed by it (graphics frames) invalidate.
 */
export async function bundleRuntime(entry: string, cacheDir: string, opts: { alias?: Record<string, string>; external?: string[]; nodePaths?: string[] } = {}): Promise<string> {
  const esbuild = await import("esbuild");
  const r = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    write: false,
    minify: false,
    alias: opts.alias,
    external: opts.external,
    nodePaths: opts.nodePaths,
    logLevel: "silent",
  });
  const code = r.outputFiles[0]!.contents;
  const h = createHash("sha256").update(code).digest("hex").slice(0, 16);
  const out = join(cacheDir, `${h}.js`);
  if (existsSync(out)) return out;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, code);
  return out;
}
