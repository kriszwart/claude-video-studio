import { join, resolve } from "node:path";
import { getDb, getProviderSettings, JobError, subscriptionRuntimeAllowed } from "@vs/db";
import { CodexError, CodexImages, CodexSettings } from "@vs/providers";
import { FFMPEG, runOk } from "@vs/rendering";
import { registerFile, resolveAssets, type Handler } from "../context";

/**
 * Library image from a prompt through the owner's ChatGPT plan (local Codex CLI). Not tied to a
 * project, so it never touches a project budget: plan images cost no money. A plan usage limit
 * pauses the job (usage_limit) like Claude's; it never falls back to paid billing.
 */
export const generateImage: Handler = async (ctx) => {
  const prompt = String(ctx.job.input.prompt ?? "").slice(0, 2000);
  const aspectRatio = String(ctx.job.input.aspectRatio ?? "16:9");
  const referenceAssetIds = (Array.isArray(ctx.job.input.referenceAssetIds) ? ctx.job.input.referenceAssetIds : []).map(String).slice(0, 3);
  if (!prompt.trim()) throw new JobError("invalid_input", "Describe the image to generate.", false);
  const cx = CodexSettings.safeParse(await getProviderSettings(getDb(), ctx.job.workspaceId, "codex"));
  if (!cx.success || !cx.data.enabled || !subscriptionRuntimeAllowed()) throw new JobError("provider_not_configured", "Images with ChatGPT is turned off.", false, "Turn it on in Settings → Providers → Images with ChatGPT.");

  await ctx.stage("preparing references");
  const files = await resolveAssets(ctx.job.workspaceId, referenceAssetIds);
  const refs: string[] = [];
  for (const [i, id] of referenceAssetIds.entries()) {
    const small = resolve(ctx.workDir, `ref-${i}.jpg`);
    await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", files.get(id)!.path, "-vf", "scale='min(1024,iw)':-2", "-frames:v", "1", "-q:v", "3", small], { timeoutMs: 60_000 });
    refs.push(small);
  }

  await ctx.stage("generating with ChatGPT");
  let result;
  try {
    result = await new CodexImages().generate({ prompt, referencePaths: refs, aspectRatio, cwd: resolve(ctx.workDir), signal: ctx.signal });
  } catch (e) {
    const err = e instanceof CodexError ? e : new CodexError("provider_failed", String(e), false);
    throw new JobError(err.code, err.message, err.retryable, err.recovery);
  }

  await ctx.stage("saving image");
  const out = join(ctx.workDir, "image.png");
  await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", result.file, "-frames:v", "1", out], { timeoutMs: 60_000 });
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "image";
  const asset = await registerFile(ctx.job.workspaceId, out, {
    kind: "image",
    originalName: `chatgpt-${slug}.png`,
    mime: "image/png",
    generated: true,
    provenance: { source: "generated", provider: "codex", model: "ChatGPT image (Codex CLI)", requestId: result.threadId, prompt, aspectRatio, referenceAssetIds, generatedAt: new Date().toISOString(), billing: "ChatGPT plan" },
  });
  return { assetId: asset.id };
};
