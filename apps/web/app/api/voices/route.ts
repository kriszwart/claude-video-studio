import { desc, gt } from "drizzle-orm";
import { getDb, getOmniVoiceConfig, providerStatus, schema } from "@vs/db";
import { OmniVoiceTts } from "@vs/providers";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";

/** Voices actually available: local voices reported by live workers, plus hosted providers when configured. */
export const GET = route(async () => {
  const s = await requireSession();
  const workers = await getDb().query.workerCapabilities.findMany({ where: gt(schema.workerCapabilities.heartbeatAt, new Date(Date.now() - 120_000)), orderBy: desc(schema.workerCapabilities.heartbeatAt) });
  const voices = new Map<string, { id: string; label: string; language: string; kind: string }>();
  for (const w of workers) for (const v of ((w.capabilities as { tts?: { voices?: { id: string; label: string; language: string }[] } }).tts?.voices ?? [])) voices.set(v.id, { ...v, kind: "local" });
  const providers = await providerStatus(getDb(), s.workspaceId);
  const eleven = providers.find((p) => p.provider === "elevenlabs");
  // OmniVoice runs on the owner's machine: list the voices its server (and Settings) provide.
  const omniCfg = await getOmniVoiceConfig(getDb(), s.workspaceId);
  let omnivoice: { configured: boolean; reachable?: boolean; message?: string } = { configured: false };
  if (omniCfg) {
    try {
      const list = await new OmniVoiceTts(omniCfg.settings, omniCfg.apiKey).voices(3000);
      for (const v of list) voices.set(v.id, { ...v, kind: "omnivoice" });
      omnivoice = { configured: true, reachable: true };
    } catch (e) {
      omnivoice = { configured: true, reachable: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
  return json({ voices: [...voices.values()], hosted: { elevenlabs: { configured: !!eleven?.configured, note: "Voices are listed from your ElevenLabs account at synthesis time (integration unverified in this environment)." } }, omnivoice });
});
