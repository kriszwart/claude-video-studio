import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Bundle a browser runtime with esbuild; cached by source content hash. */
export async function bundleRuntime(entry: string, cacheDir: string, opts: { alias?: Record<string, string>; external?: string[]; nodePaths?: string[] } = {}): Promise<string> {
  const src = await readFile(entry);
  const aliasKey = JSON.stringify([opts.alias ?? {}, opts.nodePaths ?? []]);
  const h = createHash("sha256").update(src).update(aliasKey).digest("hex").slice(0, 16);
  const out = join(cacheDir, `${h}.js`);
  if (existsSync(out)) return out;
  await mkdir(dirname(out), { recursive: true });
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
  await writeFile(out, r.outputFiles[0]!.contents);
  return out;
}
