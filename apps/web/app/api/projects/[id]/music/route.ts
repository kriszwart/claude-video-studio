import { z } from "zod";
import { AppError, getDb, getProviderSecret } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

/** Compose a music bed with ElevenLabs (paid; budget-checked) and put it on the timeline. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ prompt: z.string().trim().min(3).max(2000), durationSec: z.number().min(3).max(600).optional(), instrumental: z.boolean().default(true), replace: z.boolean().default(true) }));
  if (!(await getProviderSecret(getDb(), s.workspaceId, "elevenlabs"))) throw new AppError(412, "credentials_missing", "No ElevenLabs key is configured.", "Add your ElevenLabs key in Settings → Provider keys.");
  // One attempt: a paid call is never repeated automatically.
  const r = await enqueueProjectJob(s, id, "generate_music", undefined, b, idempotencyKey(req), { maxAttempts: 1 });
  return json(r, 202);
});
