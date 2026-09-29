import { createRenderJob, createRenderRequest, executeRenderJob, renderConfigFromRequest, resolveConfig } from "@hyperframes/producer";
import { closeBrowserPool } from "@hyperframes/engine";

const projectDir = process.argv[2] ?? "/tmp/spike/proj";
const outputPath = process.argv[3] ?? "/tmp/spike/out.mp4";
const chromePath = "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";
const t0 = Date.now();
const engineConfig = resolveConfig({ chromePath, browserGpuMode: "software", concurrency: 2 } as never);
const request = createRenderRequest({ projectDir, outputPath, engineConfig, options: { fps: { num: 30, den: 1 }, quality: "standard", format: "mp4", workers: 2 } } as never);
const job = createRenderJob(renderConfigFromRequest(request as never, {} as never));
let last = "";
await executeRenderJob(job, projectDir, outputPath, (j, msg) => {
  const line = `${j.currentStage ?? ""} ${Math.round(j.progress ?? 0)}% ${msg ?? ""}`;
  if (line !== last) console.log(line), (last = line);
});
console.log(JSON.stringify({ status: job.status, outcome: (job as any).outcome, warnings: (job as any).warnings, frames: (job as any).framesRendered, ms: Date.now() - t0 }, null, 1));
await closeBrowserPool();
