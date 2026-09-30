import { z } from "zod";
import { AppError, getDb, getProviderSecret, PROVIDERS, providerStatus, recordProviderCheck, setProviderSecret, setProviderSettings, type ProviderId } from "@vs/db";
import { checkClaude, FalSettings } from "@vs/providers";
import { requireOwner } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";

const Provider = z.enum(Object.keys(PROVIDERS) as [ProviderId, ...ProviderId[]]);

/** Provider status never includes secrets — only whether one is configured and its last 4 characters. */
export const GET = route(async () => {
  const s = await requireOwner();
  return json({ providers: await providerStatus(getDb(), s.workspaceId) });
});

export const PUT = route(async (req) => {
  const s = await requireOwner();
  const b = await body(req, z.object({ provider: Provider, secret: z.string().min(8).max(400).nullable() }));
  await setProviderSecret(getDb(), s.workspaceId, b.provider, b.secret?.trim() ?? null);
  return json({ providers: await providerStatus(getDb(), s.workspaceId) });
});

/** Live credential check (a real API call to the provider; for Claude this checks the optional API key only). */
export const POST = route(async (req) => {
  const s = await requireOwner();
  const b = await body(req, z.object({ provider: Provider }));
  const secret = await getProviderSecret(getDb(), s.workspaceId, b.provider);
  let result: { ok: boolean; message: string; model?: string };
  if (!secret) result = { ok: false, message: "No key configured." };
  else if (b.provider === "anthropic") result = await checkClaude(secret.secret);
  else result = { ok: false, message: "A live check for this provider is not implemented; its integration is unverified." };
  await recordProviderCheck(getDb(), s.workspaceId, b.provider, { ...result, at: new Date().toISOString() });
  return json({ check: result, providers: await providerStatus(getDb(), s.workspaceId) });
});

/** Non-secret settings, e.g. fal model endpoints and owner-entered prices. */
export const PATCH = route(async (req) => {
  const s = await requireOwner();
  const b = await body(req, z.object({ provider: Provider, settings: z.record(z.string(), z.unknown()) }));
  if (b.provider !== "fal") throw new AppError(422, "invalid_input", "This provider has no configurable settings.");
  const parsed = FalSettings.parse(b.settings);
  await setProviderSettings(getDb(), s.workspaceId, b.provider, parsed);
  return json({ providers: await providerStatus(getDb(), s.workspaceId) });
});
