import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { enqueueProjectJob } from "@/lib/server/jobs";

/** (Re)transcribe the source recording: import subtitles or use a configured provider. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ provider: z.enum(["auto", "subtitle", "elevenlabs", "whisper-cpp"]).default("auto"), subtitleAssetId: z.string().max(64).optional(), language: z.string().max(8).optional(), force: z.boolean().default(false) }));
  const r = await enqueueProjectJob(s, id, "transcribe", undefined, b, idempotencyKey(req));
  return json(r, 202);
});
