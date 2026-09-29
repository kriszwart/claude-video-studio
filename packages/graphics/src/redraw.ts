import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { bundleRuntime } from "./build";

const exec = promisify(execFile);
const here = new URL(".", import.meta.url).pathname;
const REPO_ROOT = resolve(here, "..", "..", "..");

/**
 * Redraw is subscriber-licensed. The app never commits or redistributes it: the worker
 * uses an authorized release tarball placed in vendor/redraw/ (gitignored) or pointed to
 * by REDRAW_TARBALL, records its version + checksum, and bundles it locally.
 */
export async function findRedrawTarball(): Promise<string | null> {
  if (process.env.REDRAW_TARBALL) return existsSync(process.env.REDRAW_TARBALL) ? process.env.REDRAW_TARBALL : null;
  const dir = join(REPO_ROOT, "vendor", "redraw");
  if (!existsSync(dir)) return null;
  const tgz = (await readdir(dir)).filter((f) => /^redraw-\d+\.\d+\.\d+\.tgz$/.test(f)).sort((a, b) => cmpVer(b, a));
  return tgz[0] ? join(dir, tgz[0]) : null;
}

function cmpVer(a: string, b: string) {
  const pa = a.match(/(\d+)\.(\d+)\.(\d+)/)!.slice(1).map(Number);
  const pb = b.match(/(\d+)\.(\d+)\.(\d+)/)!.slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

export async function redrawAvailable(): Promise<{ available: boolean; version: string | null; checksum: string | null; tarball: string | null; reason?: string }> {
  const tarball = await findRedrawTarball();
  if (!tarball) return { available: false, version: null, checksum: null, tarball: null, reason: "No authorized Redraw release tarball found (vendor/redraw/redraw-X.Y.Z.tgz or REDRAW_TARBALL). See docs/redraw.md." };
  const checksum = createHash("sha256").update(await readFile(tarball)).digest("hex");
  const version = tarball.match(/redraw-(\d+\.\d+\.\d+)\.tgz$/)?.[1] ?? null;
  const expected = process.env.REDRAW_SHA256;
  if (expected && expected !== checksum) return { available: false, version, checksum, tarball, reason: `Redraw tarball checksum ${checksum.slice(0, 12)} does not match REDRAW_SHA256.` };
  if (process.env.REDRAW_DISABLED === "1") return { available: false, version, checksum, tarball, reason: "Redraw is disabled on this worker (REDRAW_DISABLED=1)." };
  return { available: true, version, checksum, tarball };
}

export async function redrawRuntime(cacheDir: string): Promise<{ ok: true; runtime: string; version: string; checksum: string } | { ok: false; reason: string }> {
  const a = await redrawAvailable();
  if (!a.available || !a.tarball || !a.version || !a.checksum) return { ok: false, reason: a.reason ?? "Redraw unavailable." };
  const dir = join(cacheDir, `redraw-${a.version}-${a.checksum.slice(0, 12)}`);
  if (!existsSync(join(dir, "package", "dist", "index.mjs"))) {
    await mkdir(dir, { recursive: true });
    await exec("tar", ["xzf", a.tarball, "-C", dir]);
  }
  const runtime = await bundleRuntime(join(here, "runtime", "redraw-runtime.ts"), join(cacheDir, "redraw-runtime"), {
    alias: { redraw: join(dir, "package", "dist", "index.mjs") },
    // Redraw's only runtime dependency (typegpu) comes from this package's public npm deps.
    nodePaths: [join(here, "..", "node_modules")],
  });
  return { ok: true, runtime, version: a.version, checksum: a.checksum };
}
