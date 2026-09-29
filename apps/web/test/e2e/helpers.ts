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
    // Tolerate transient dev-server responses (e.g. an HTML error page during a hot reload).
    const v = r.ok() ? await r.json().catch(() => null) : null;
    if (!v) {
      await new Promise((res) => setTimeout(res, 2000));
      continue;
    }
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

/** Upload a fixture through the public API (authorise → PUT → finalize → wait for ingest). */
export async function apiUpload(request: APIRequestContext, file: string, mime: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync(file);
  const a = await (await request.post("/api/assets/uploads", { data: { filename: file.split("/").pop(), mime, bytes: bytes.length, rightsAcknowledged: true } })).json();
  const put = await request.put(a.uploadUrl, { data: bytes, headers: { "content-type": "application/octet-stream" } });
  expect(put.status()).toBe(200);
  const fin = await (await request.post(`/api/assets/${a.asset.id}/finalize`)).json();
  for (let i = 0; i < 120; i++) {
    const j = (await (await request.get(`/api/jobs/${fin.job.id}`)).json()).job;
    if (j.status === "succeeded") return String(j.result.assetId);
    if (j.status === "failed") throw new Error(j.error.message);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("upload ingest timed out");
}

export async function createProject(request: APIRequestContext, data: Record<string, unknown>) {
  const r = await request.post("/api/projects", { data });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()) as { project: { id: string }; doc: { scenes: { id: string; durationFrames: number; purpose: string }[] } };
}

export async function renderAndWait(request: APIRequestContext, projectId: string, kind: "preview" | "exports") {
  const t0 = Date.now();
  const r = await request.post(`/api/projects/${projectId}/${kind}`, { data: {} });
  expect(r.status()).toBe(202);
  return waitForJobs(request, projectId, kind === "exports" ? "export" : "preview", t0, 40 * 60_000);
}
