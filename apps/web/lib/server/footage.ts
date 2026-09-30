import "server-only";
import { AppError, getDb, getProviderSecret } from "@vs/db";
import { FOOTAGE_SOURCES, FootageError, footageAdapter, type FootageSource } from "@vs/providers";

/** Footage adapters with their API keys (Pexels/Pixabay) resolved server-side; keys never reach the browser. */
export async function adapterFor(workspaceId: string, source: FootageSource) {
  const meta = FOOTAGE_SOURCES.find((s) => s.id === source);
  if (!meta) throw new AppError(400, "invalid_source", "Unknown footage source.");
  const key = meta.keyProvider ? (await getProviderSecret(getDb(), workspaceId, meta.keyProvider))?.secret : undefined;
  return footageAdapter(source, { apiKey: key });
}

export async function footageSources(workspaceId: string) {
  const out = [];
  for (const s of FOOTAGE_SOURCES) {
    const configured = !s.needsKey || !!(await getProviderSecret(getDb(), workspaceId, s.keyProvider!));
    out.push({ id: s.id, label: s.label, needsKey: s.needsKey, available: configured, setup: configured ? null : `Add a free ${s.label} API key in Settings → Provider keys.` });
  }
  return out;
}

/** Map adapter errors to API errors with a clear message. */
export function footageAppError(e: unknown): unknown {
  if (e instanceof FootageError) return new AppError(e.status, e.code === "not_configured" ? "footage_not_configured" : `footage_${e.code}`, e.message, e.code === "not_configured" ? "Settings → Provider keys" : undefined);
  return e;
}
