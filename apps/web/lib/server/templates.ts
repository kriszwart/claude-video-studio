import "server-only";
import { desc, gt } from "drizzle-orm";
import { getDb, providerStatus, schema } from "@vs/db";
import type { TemplateDefinition } from "@vs/templates";

/**
 * Honest availability: a template is "ready" only when every required capability is
 * configured on the server and a worker has reported the runtime it needs.
 */
export async function templateAvailability(def: TemplateDefinition, workspaceId: string) {
  const providers = await providerStatus(getDb(), workspaceId);
  const configured = (p: string) => providers.find((x) => x.provider === p)?.configured ?? false;
  const workers = await getDb().query.workerCapabilities.findMany({ where: gt(schema.workerCapabilities.heartbeatAt, new Date(Date.now() - 120_000)), orderBy: desc(schema.workerCapabilities.heartbeatAt) });
  const caps = workers.map((w) => w.capabilities as { tts?: { pico?: boolean; espeak?: boolean }; transcription?: { whisperCpp?: boolean }; graphics?: { skia?: boolean; redraw?: boolean } });
  const any = (f: (c: (typeof caps)[number]) => boolean | undefined) => caps.some((c) => !!f(c));
  const check: Record<string, () => boolean> = {
    planner: () => configured("anthropic"),
    tts: () => any((c) => c.tts?.pico || c.tts?.espeak) || configured("elevenlabs"),
    transcription: () => any((c) => c.transcription?.whisperCpp) || configured("elevenlabs"),
    "image-generation": () => configured("fal"),
    "video-generation": () => configured("fal"),
    segmentation: () => false,
    "graphics-redraw": () => any((c) => c.graphics?.redraw),
    "graphics-skia": () => any((c) => c.graphics?.skia),
  };
  const missingRequired = def.providers.required.filter((c) => !check[c]?.());
  const missingOptional = def.providers.optional.filter((c) => !check[c]?.());
  return { ready: missingRequired.length === 0 && workers.length > 0, workerOnline: workers.length > 0, missingRequired, missingOptional };
}
