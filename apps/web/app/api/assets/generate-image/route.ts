import { z } from "zod";
import { AppError, enqueueJob, getDb, getProviderSettings, subscriptionRuntimeAllowed } from "@vs/db";
import { CodexSettings } from "@vs/providers";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { serializeJob } from "@/lib/server/serialize";

const IMAGE_ASPECTS = ["16:9", "9:16", "1:1", "4:5", "3:2", "2:3"] as const;

/**
 * Generate a library image from a prompt with the owner's ChatGPT plan (local Codex CLI).
 * Plan images cost no money, so no budget applies; a usage limit pauses the job.
 */
export const POST = route(async (req) => {
  const s = await requireSession();
  const b = await body(req, z.object({ prompt: z.string().trim().min(3).max(2000), aspectRatio: z.enum(IMAGE_ASPECTS).default("16:9"), referenceAssetIds: z.array(z.string().max(64)).max(3).default([]) }));
  const cx = CodexSettings.safeParse(await getProviderSettings(getDb(), s.workspaceId, "codex"));
  if (!subscriptionRuntimeAllowed()) throw new AppError(409, "provider_not_configured", "Images with ChatGPT are only available in a personal local studio.");
  if (!cx.success || !cx.data.enabled) throw new AppError(409, "provider_not_configured", "Images with ChatGPT is turned off.", "Turn it on in Settings → Providers → Images with ChatGPT.");
  const idem = idempotencyKey(req);
  const { job } = await enqueueJob(getDb(), { workspaceId: s.workspaceId, type: "generate_image", input: b, idempotencyKey: idem ? `img:${idem}` : null, maxAttempts: 1 });
  return json({ job: serializeJob(job) }, 202);
});
