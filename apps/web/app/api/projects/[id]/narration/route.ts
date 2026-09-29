import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

/** Generate per-scene narration (TTS) and caption cues timed to the audio. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ voiceId: z.string().max(120), rate: z.number().min(0.7).max(1.4).default(1), fit: z.enum(["extend", "keep"]).default("extend"), sceneIds: z.array(z.string().max(64)).max(60).optional() }));
  const r = await enqueueProjectJob(s, id, "tts", undefined, b, idempotencyKey(req));
  return json(r, 202);
});
