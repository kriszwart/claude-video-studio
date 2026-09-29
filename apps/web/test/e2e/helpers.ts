import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const FIX = join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "sample");
export const ART = join(import.meta.dirname, "..", "..", "..", "..", "artifacts", "e2e");
mkdirSync(ART, { recursive: true });

export async function waitForJobs(request: APIRequestContext, projectId: string, type: string, since: number, timeoutMs = 10 * 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await request.get(`/api/projects/${projectId}`);
    const v = await r.json();
    const j = v.jobs.find((x: { type: string; createdAt: string }) => x.type === type && new Date(x.createdAt).getTime() >= since - 2000);
    if (j && ["succeeded", "failed", "canceled"].includes(j.status)) return { job: j, view: v };
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`timed out waiting for ${type}`);
}

/** Download an export via its signed URL and run ffprobe/decoding checks locally. */
export async function downloadAndProbe(page: Page, url: string, name: string) {
  const res = await page.request.get(url);
  expect(res.status()).toBe(200);
  const file = join(ART, name);
  writeFileSync(file, await res.body());
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]).toString());
  return { file, probe };
}

export function frameAt(file: string, t: number, out: string) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", file, "-frames:v", "1", join(ART, out)]);
  return join(ART, out);
}

export async function uploadVia(page: Page, container: ReturnType<Page["locator"]>, files: string[]) {
  await container.getByRole("button", { name: /Choose|Change/ }).click();
  await container.getByLabel(/I have the rights/).check();
  await container.locator('input[type="file"]').setInputFiles(files);
}
