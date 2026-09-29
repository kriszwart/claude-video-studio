import { desc, gt } from "drizzle-orm";
import { getDb, providerStatus, schema } from "@vs/db";
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
  return json({ voices: [...voices.values()], hosted: { elevenlabs: { configured: !!eleven?.configured, note: "Voices are listed from your ElevenLabs account at synthesis time (integration unverified in this environment)." } } });
});
