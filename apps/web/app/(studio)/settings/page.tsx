"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { useClaudeStatus, type ClaudeStatus } from "@/lib/client/claude";

interface P { provider: string; label: string; capabilities: string[]; configured: boolean; source: "settings" | "env" | null; keyHint: string | null; lastCheck: { ok: boolean; message: string; at: string } | null; settings?: Record<string, unknown> }

export default function Settings() {
  const [providers, setProviders] = useState<P[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  useEffect(() => {
    api<{ providers: P[] }>("/api/settings/providers").then((r) => setProviders(r.providers)).catch((e) => setMsg({ _: e.message }));
  }, []);
  const call = async (p: string, fn: () => Promise<{ providers: P[]; check?: { ok: boolean; message: string } }>) => {
    try {
      const r = await fn();
      setProviders(r.providers);
      setMsg((m) => ({ ...m, [p]: r.check ? `${r.check.ok ? "✓" : "✗"} ${r.check.message}` : "Saved." }));
    } catch (e) {
      setMsg((m) => ({ ...m, [p]: e instanceof ApiError ? e.message : String(e) }));
    }
  };
  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="mb-1 text-xl font-semibold">Settings</h1>
      <p className="mb-6 text-sm text-dim">Keys are stored encrypted on the server (or read from server environment variables) and are never shown again or sent to the browser. Never paste keys into project chat.</p>
      {msg._ && <p className="text-bad">{msg._}</p>}
      <ClaudeRuntime />
      <h2 className="mb-2 mt-8 text-lg font-semibold">Provider keys</h2>
      <ul className="space-y-4">
        {providers.map((p) => (
          <li key={p.provider} className="card p-4">
            <div className="mb-1 flex items-center gap-2">
              <h2 className="font-medium">{p.label}</h2>
              <span className={`chip ${p.configured ? "text-ok" : ""}`}>{p.configured ? `Configured (${p.source === "env" ? "server env" : `settings ${p.keyHint ?? ""}`})` : "Not configured"}</span>
            </div>
            <p className="mb-3 text-xs text-faint">Used for: {p.capabilities.join(", ")}</p>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void call(p.provider, () => api("/api/settings/providers", { method: "PUT", json: { provider: p.provider, secret: keys[p.provider] || null } }));
                setKeys((k) => ({ ...k, [p.provider]: "" }));
              }}
            >
              <label className="sr-only" htmlFor={`k-${p.provider}`}>{p.label} API key</label>
              <input id={`k-${p.provider}`} className="input max-w-xs" type="password" autoComplete="off" placeholder="Paste a new key to replace" value={keys[p.provider] ?? ""} onChange={(e) => setKeys((k) => ({ ...k, [p.provider]: e.target.value }))} />
              <button className="btn" disabled={!keys[p.provider]}>Save key</button>
              <button type="button" className="btn" disabled={!p.configured} onClick={() => call(p.provider, () => api("/api/settings/providers", { method: "POST", json: { provider: p.provider } }))}>Test connection</button>
              {p.source === "settings" && <button type="button" className="btn btn-danger" onClick={() => call(p.provider, () => api("/api/settings/providers", { method: "PUT", json: { provider: p.provider, secret: null } }))}>Remove</button>}
            </form>
            {p.provider === "omnivoice" && <OmniVoiceSettingsForm settings={(p.settings ?? {}) as OmniSettings} onSave={(settings) => call(p.provider, () => api("/api/settings/providers", { method: "PATCH", json: { provider: "omnivoice", settings } }))} />}
            {p.provider === "openrouter" && <OpenRouterModel settings={(p.settings ?? {}) as OrSettings} onSave={(settings) => call(p.provider, () => api("/api/settings/providers", { method: "PATCH", json: { provider: "openrouter", settings } }))} />}
            {p.provider === "elevenlabs" && p.configured && <ElevenLabsMusic settings={(p.settings ?? {}) as ElMusicSettings} onSave={(settings) => call(p.provider, () => api("/api/settings/providers", { method: "PATCH", json: { provider: "elevenlabs", settings } }))} />}
            {p.provider === "fal" && <FalModels settings={(p.settings ?? {}) as FalModelSettings} onSave={(settings) => call(p.provider, () => api("/api/settings/providers", { method: "PATCH", json: { provider: "fal", settings } }))} />}
            {(msg[p.provider] || p.lastCheck) && <p className="mt-2 text-xs text-dim" role="status">{msg[p.provider] ?? `Last check ${new Date(p.lastCheck!.at).toLocaleString()}: ${p.lastCheck!.ok ? "✓" : "✗"} ${p.lastCheck!.message}`}</p>}
          </li>
        ))}
      </ul>
    </main>
  );
}

type Model = { endpoint: string; priceMicros: number | null; priceCheckedAt?: string; maxDurationSec?: number; notes?: string };
type FalModelSettings = { image?: Model; video?: Model };

/** Owner-entered fal models: endpoint ids and prices come from fal's own pages, not from the studio. */
interface OrSettings {
  image?: { model: string; priceMicros: number | null; priceCheckedAt?: string };
  preferForImages?: boolean;
}

/** OpenRouter image model: the model id and its current price per image, both copied from OpenRouter. */
function OpenRouterModel({ settings, onSave }: { settings: OrSettings; onSave: (s: OrSettings) => void }) {
  const [model, setModel] = useState(settings.image?.model ?? "");
  const [price, setPrice] = useState(settings.image?.priceMicros != null ? String(settings.image.priceMicros / 1_000_000) : "");
  const [prefer, setPrefer] = useState(settings.preferForImages ?? true);
  return (
    <form
      className="mt-3 grid grid-cols-1 gap-2 border-t border-line pt-3 text-xs sm:grid-cols-3"
      aria-label="OpenRouter image model"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ...(model.trim() ? { image: { model: model.trim(), priceMicros: price.trim() ? Math.round(Number(price) * 1_000_000) : null, priceCheckedAt: new Date().toISOString().slice(0, 10) } } : {}), preferForImages: prefer });
      }}
    >
      <p className="text-faint sm:col-span-3">Image shots and keyframes can be generated through OpenRouter with one key: copy an image-output model id and its price per image from OpenRouter. Reference images (product shots, characters) are sent with each request. Claude is never routed through OpenRouter.</p>
      <label className="flex flex-col gap-1">Image model id<input className="input" aria-label="OpenRouter image model id" placeholder="provider/model" value={model} onChange={(e) => setModel(e.target.value)} /></label>
      <label className="flex flex-col gap-1">Price per image ($)<input className="input" inputMode="decimal" aria-label="OpenRouter price per image" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
      <label className="flex items-center gap-1.5 self-end pb-2"><input type="checkbox" checked={prefer} onChange={(e) => setPrefer(e.target.checked)} /> Prefer over fal for images</label>
      <button className="btn sm:col-span-3">Save OpenRouter model</button>
    </form>
  );
}

interface ElMusicSettings {
  musicPriceMicrosPerMinute?: number | null;
  priceCheckedAt?: string;
  musicModel?: string;
}

/** ElevenLabs music: the owner's price per minute from their plan (optional) and a pinned model. */
function ElevenLabsMusic({ settings, onSave }: { settings: ElMusicSettings; onSave: (s: ElMusicSettings) => void }) {
  const [price, setPrice] = useState(settings.musicPriceMicrosPerMinute != null ? String(settings.musicPriceMicrosPerMinute / 1_000_000) : "");
  const [model, setModel] = useState(settings.musicModel ?? "");
  return (
    <form
      className="mt-3 grid grid-cols-1 gap-2 border-t border-line pt-3 text-xs sm:grid-cols-3"
      aria-label="ElevenLabs music"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ musicPriceMicrosPerMinute: price.trim() ? Math.round(Number(price) * 1_000_000) : null, priceCheckedAt: new Date().toISOString().slice(0, 10), ...(model.trim() ? { musicModel: model.trim() } : {}) });
      }}
    >
      <p className="text-faint sm:col-span-3">Music generation (Audio tab) is billed by ElevenLabs from your plan. Enter what a minute of music costs you so the project budget can track it; leave it empty and each request needs an explicit unknown-price authorisation in the project budget.{settings.priceCheckedAt ? ` Price last entered ${settings.priceCheckedAt}.` : ""}</p>
      <label className="flex flex-col gap-1">Music price per minute ($)<input className="input" inputMode="decimal" aria-label="Music price per minute" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
      <label className="flex flex-col gap-1">Music model (optional)<input className="input" placeholder="API default" value={model} onChange={(e) => setModel(e.target.value)} /></label>
      <button className="btn self-end">Save music settings</button>
    </form>
  );
}

function FalModels({ settings, onSave }: { settings: FalModelSettings; onSave: (s: FalModelSettings) => void }) {
  const [form, setForm] = useState(() => ({
    imageEndpoint: settings.image?.endpoint ?? "",
    imagePrice: settings.image?.priceMicros != null ? String(settings.image.priceMicros / 1_000_000) : "",
    videoEndpoint: settings.video?.endpoint ?? "",
    videoPrice: settings.video?.priceMicros != null ? String(settings.video.priceMicros / 1_000_000) : "",
    videoMax: settings.video?.maxDurationSec ? String(settings.video.maxDurationSec) : "",
  }));
  const f = (k: keyof typeof form) => ({ value: form[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((x) => ({ ...x, [k]: e.target.value })) });
  const model = (endpoint: string, price: string, max?: string): Model | undefined =>
    endpoint.trim() ? { endpoint: endpoint.trim(), priceMicros: price.trim() ? Math.round(Number(price) * 1_000_000) : null, priceCheckedAt: new Date().toISOString().slice(0, 10), ...(max ? { maxDurationSec: Number(max) } : {}) } : undefined;
  return (
    <form
      className="mt-3 grid grid-cols-1 gap-2 border-t border-line pt-3 text-xs sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ image: model(form.imageEndpoint, form.imagePrice), video: model(form.videoEndpoint, form.videoPrice, form.videoMax) });
      }}
    >
      <p className="text-faint sm:col-span-3">Generation models (fal endpoint ids, e.g. owner/model). Copy the endpoint and its current price from fal. Leave the price empty if you don't know it: each request then needs an explicit per-project authorisation.</p>
      <label className="flex flex-col gap-1">Image endpoint<input className="input" placeholder="owner/image-model" {...f("imageEndpoint")} /></label>
      <label className="flex flex-col gap-1">Image price per request ($)<input className="input" inputMode="decimal" {...f("imagePrice")} /></label>
      <span />
      <label className="flex flex-col gap-1">Video endpoint<input className="input" placeholder="owner/video-model" {...f("videoEndpoint")} /></label>
      <label className="flex flex-col gap-1">Video price per request ($)<input className="input" inputMode="decimal" {...f("videoPrice")} /></label>
      <label className="flex flex-col gap-1">Max clip length (s)<input className="input" inputMode="numeric" {...f("videoMax")} /></label>
      <button className="btn sm:col-span-3">Save models</button>
    </form>
  );
}

const MODES: { id: ClaudeStatus["runtime"]["mode"]; label: string; help: string }[] = [
  { id: "subscription", label: "Claude subscription via Claude Code (default)", help: "Uses the Claude Code installed and signed in on this computer. Counts toward your Pro/Max plan's usage limits; no API key and no API charges." },
  { id: "api", label: "Claude API key (billed separately)", help: "Uses the Anthropic API key below, billed per token to that API account. Only used when you select it here." },
  { id: "off", label: "Off", help: "No AI actions. Manual editing, rendering and exports keep working." },
];

/** Claude runtime: mode choice, sign-in status, usage-window status as reported, and billing-override warnings. */
function ClaudeRuntime() {
  const [s, set] = useClaudeStatus();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<ClaudeStatus>) => {
    setBusy(true);
    setErr(null);
    try {
      set(await fn());
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!s) return <section id="claude" className="card p-4 text-sm text-dim">Checking Claude…</section>;
  const { readiness: r, runtime: rt } = s;
  const check = rt.lastCheck;
  const limit = rt.lastLimit;
  return (
    <section id="claude" className="card space-y-3 p-4 text-sm" aria-labelledby="claude-h">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="claude-h" className="font-medium">Claude</h2>
        <span className={`chip ${r.available ? "text-ok" : "text-warn"}`}>{r.available ? "AI actions available" : "AI actions unavailable"}</span>
      </div>
      <fieldset className="space-y-2">
        <legend className="sr-only">Claude runtime</legend>
        {MODES.map((m) => (
          <label key={m.id} className="flex gap-2">
            <input type="radio" name="claude-mode" checked={rt.mode === m.id} disabled={busy || (m.id === "subscription" && !rt.subscriptionAllowed && rt.mode !== "subscription")} onChange={() => run(() => api<ClaudeStatus>("/api/settings/claude", { method: "PUT", json: { mode: m.id } }))} />
            <span>
              <span className="font-medium">{m.label}</span>
              <span className="block text-xs text-faint">{m.id === "subscription" && !rt.subscriptionAllowed ? "Only for a personal local studio (one owner, this computer). This studio serves other users, so it must use an API key." : m.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p role="status" className={r.available ? "text-dim" : "text-warn"}>
        {r.message} {r.recovery && <span className="text-dim">{r.recovery}</span>}
      </p>
      {rt.mode === "subscription" && rt.subscriptionAllowed && (
        <div className="space-y-1 text-xs text-dim">
          <p>
            Signed-in account: {check ? (check.plan ? `${check.plan} (${check.observed.replace("_", " ")})` : check.observed.replace("_", " ")) : "not checked yet"}
            {check && <span className="text-faint"> · checked {new Date(check.at).toLocaleString()}</span>}
          </p>
          <p>
            Plan usage:{" "}
            {limit
              ? `${limit.status === "rejected" ? "limit reached" : limit.status === "allowed_warning" ? "approaching the limit" : "within limits"}${limit.rateLimitType ? ` (${limit.rateLimitType.replace(/_/g, " ")} window)` : ""}${typeof limit.utilization === "number" ? `, ${Math.round(limit.utilization * 100)}% used` : ""}${limit.resetsAt ? `, resets ${new Date(limit.resetsAt).toLocaleString()}` : ""} — as reported by Claude Code on ${new Date(limit.at).toLocaleString()}`
              : "unavailable (Claude Code reports it only while a request runs)"}
          </p>
          <p className="text-faint">At a usage limit, AI jobs pause with a Resume button. The studio never switches accounts, turns on extra usage or falls back to an API key.</p>
          <button className="btn mt-1" disabled={busy} onClick={() => run(() => api<ClaudeStatus>("/api/settings/claude", { method: "POST" }))}>
            {busy ? "Checking…" : "Check runtime"}
          </button>
          <p className="text-faint">The check asks Claude Code which account it is signed in with; it sends no prompt and uses none of your plan. The studio never reads or stores your Claude login.</p>
        </div>
      )}
      {rt.mode === "api" && <p className="text-xs text-dim">API key: {rt.apiKeyConfigured ? `configured (${rt.apiKeySource === "env" ? "server environment" : "Settings"})` : "not configured — add it under Provider keys below"}.</p>}
      {rt.overrides.length > 0 && (
        <p className="rounded-md border border-line bg-panel-2 p-2 text-xs">
          <span className="text-warn">Billing override detected:</span> {rt.overrides.join(", ")} {rt.overrides.length === 1 ? "is" : "are"} set in the studio server&apos;s environment (values not shown). In subscription mode the studio does not pass {rt.overrides.length === 1 ? "it" : "them"} to Claude Code, but {rt.overrides.length === 1 ? "it" : "they"} can make Claude Code in your own terminal bill an API account or another provider instead of your plan. The studio does not change your shell configuration.
        </p>
      )}
      {err && <p className="text-bad">{err}</p>}
    </section>
  );
}

type OmniVoice = { name: string; label?: string; instructions?: string; language?: string };
type OmniSettings = { baseUrl?: string; model?: string; voices?: OmniVoice[] };

/**
 * OmniVoice runs on this computer (an OpenAI-compatible OmniVoice server). Voices listed by the
 * server appear automatically; add names here for cloned voices it doesn't list, or designed
 * voices described in words.
 */
function OmniVoiceSettingsForm({ settings, onSave }: { settings: OmniSettings; onSave: (s: OmniSettings) => void }) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? "");
  const [model, setModel] = useState(settings.model ?? "");
  const [voices, setVoices] = useState<OmniVoice[]>(settings.voices ?? []);
  const upd = (i: number, patch: Partial<OmniVoice>) => setVoices((v) => v.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3 text-xs">
      <p className="text-faint">
        Open the OmniVoice Studio app on this computer (it serves voices at <code>http://127.0.0.1:3900/v1</code> while it is open), or run an OmniVoice server such as <code>omnivoice-server</code>, then enter its address. The app must be open whenever you generate narration with its voices. The API key above is only needed if your server requires one. Only clone voices you have permission to use.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          Server address
          <input className="input" placeholder="http://127.0.0.1:3900/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <span className="flex flex-wrap gap-1">
            <button type="button" className="btn btn-ghost px-1 py-0 text-xs" onClick={() => setBaseUrl("http://127.0.0.1:3900/v1")}>OmniVoice Studio app (port 3900)</button>
            <button type="button" className="btn btn-ghost px-1 py-0 text-xs" onClick={() => setBaseUrl("http://127.0.0.1:8000")}>omnivoice-server (port 8000)</button>
          </span>
        </label>
        <label className="flex flex-col gap-1">Model (optional)<input className="input" placeholder="omnivoice" value={model} onChange={(e) => setModel(e.target.value)} /></label>
      </div>
      <p className="font-medium">Voices</p>
      {voices.length === 0 && <p className="text-faint">None added — voices the server lists are used automatically.</p>}
      {voices.map((v, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 rounded border border-line p-2 sm:grid-cols-[1fr_1fr_2fr_auto]">
          <input className="input" aria-label="Voice name on the server" placeholder="name on server (e.g. my_voice)" value={v.name} onChange={(e) => upd(i, { name: e.target.value })} />
          <input className="input" aria-label="Display label" placeholder="label (optional)" value={v.label ?? ""} onChange={(e) => upd(i, { label: e.target.value || undefined })} />
          <input className="input" aria-label="Voice description" placeholder="design description (optional), e.g. warm female voice, British accent, calm" value={v.instructions ?? ""} onChange={(e) => upd(i, { instructions: e.target.value || undefined })} />
          <button type="button" className="btn btn-ghost" onClick={() => setVoices((x) => x.filter((_, k) => k !== i))}>Remove</button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" onClick={() => setVoices((x) => [...x, { name: "" }])}>Add voice</button>
        <button type="button" className="btn btn-primary" onClick={() => onSave({ baseUrl: baseUrl.trim(), model: model.trim() || undefined, voices: voices.filter((v) => v.name.trim()).map((v) => ({ ...v, name: v.name.trim() })) })}>Save OmniVoice settings</button>
      </div>
    </div>
  );
}
