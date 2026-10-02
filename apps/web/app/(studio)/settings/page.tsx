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
      <GetStarted providers={providers} />
      <ClaudeRuntime />
      <Rendering />
      <h2 className="mb-2 mt-8 text-lg font-semibold">Provider keys</h2>
      <ul className="space-y-4">
        {providers.map((p) => (
          <li key={p.provider} id={`provider-${p.provider}`} className="card scroll-mt-4 p-4">
            <div className="mb-1 flex items-center gap-2">
              <h2 className="font-medium">{p.label}</h2>
              <span className={`chip ${p.configured ? "text-ok" : ""}`}>{p.configured ? `Configured (${p.source === "env" ? "server env" : `settings ${p.keyHint ?? ""}`})` : "Not configured"}</span>
            </div>
            <p className="mb-3 text-xs text-faint">Used for: {p.capabilities.join(", ")}</p>
            {p.provider === "codex" ? (
              <CodexImagesSettings
                settings={(p.settings ?? {}) as CxSettings}
                onSave={(settings) => call(p.provider, () => api("/api/settings/providers", { method: "PATCH", json: { provider: "codex", settings } }))}
                onCheck={() => call(p.provider, () => api("/api/settings/providers", { method: "POST", json: { provider: "codex" } }))}
              />
            ) : (
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
            )}
            {p.provider === "omnivoice" && <OmniVoiceSettingsForm settings={(p.settings ?? {}) as OmniSettings} onSave={(settings) => call(p.provider, () => api("/api/settings/providers", { method: "PATCH", json: { provider: "omnivoice", settings } }))} />}
            {p.provider === "openrouter" && <OpenRouterModel settings={(p.settings ?? {}) as OrSettings} onSave={(settings) => call(p.provider, () => api("/api/settings/providers", { method: "PATCH", json: { provider: "openrouter", settings } }))} />}
            {p.provider === "elevenlabs" && p.configured && <ElevenLabsMusic settings={(p.settings ?? {}) as ElMusicSettings} onSave={(settings) => call(p.provider, () => api("/api/settings/providers", { method: "PATCH", json: { provider: "elevenlabs", settings } }))} />}
            {p.provider === "lanternist" && <LanternistSettingsForm settings={(p.settings ?? {}) as { mcpUrl?: string }} onSave={(settings) => call(p.provider, () => api("/api/settings/providers", { method: "PATCH", json: { provider: "lanternist", settings } }))} />}
            {p.provider === "share" && <ShareSettingsForm settings={(p.settings ?? {}) as ShareForm} onSave={(settings) => call(p.provider, () => api("/api/settings/providers", { method: "PATCH", json: { provider: "share", settings } }))} />}
            {p.provider === "jev" && <JevSettingsForm settings={(p.settings ?? {}) as JevForm} onSave={(settings) => call(p.provider, () => api("/api/settings/providers", { method: "PATCH", json: { provider: "jev", settings } }))} />}
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

interface CxSettings {
  enabled?: boolean;
  preferForImages?: boolean;
}

/** Images through the owner's ChatGPT plan: the local Codex CLI signed in with ChatGPT. No key. */
function CodexImagesSettings({ settings, onSave, onCheck }: { settings: CxSettings; onSave: (s: CxSettings) => void; onCheck: () => void }) {
  const [enabled, setEnabled] = useState(settings.enabled ?? false);
  const [prefer, setPrefer] = useState(settings.preferForImages ?? true);
  return (
    <form
      className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2"
      aria-label="Images with ChatGPT"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ enabled, preferForImages: prefer });
      }}
    >
      <p className="text-faint sm:col-span-2">
        Image shots and keyframes can use your ChatGPT plan through the Codex CLI on this computer, the way Claude uses Claude Code. Install it (<code>npm install -g @openai/codex</code>), run <code>codex login</code> and choose Sign in with ChatGPT. Images count against your plan&apos;s limits and are never billed to an API key. Each image takes about a minute. Reference images are attached to each request.
      </p>
      <label className="flex items-center gap-1.5"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Use ChatGPT for images</label>
      <label className="flex items-center gap-1.5"><input type="checkbox" checked={prefer} onChange={(e) => setPrefer(e.target.checked)} /> Prefer over OpenRouter and fal</label>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button className="btn">Save</button>
        <button type="button" className="btn" onClick={onCheck}>Check runtime</button>
      </div>
    </form>
  );
}

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
    <section id="claude" className="card scroll-mt-4 space-y-3 p-4 text-sm" aria-labelledby="claude-h">
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

type WorkerRow = { id: string; gpu: "hardware" | "software"; gpuMode: string; redraw: boolean; skia: boolean };

/** Which render workers are running and whether they use this computer's graphics chip. */
function Rendering() {
  const [workers, setWorkers] = useState<WorkerRow[] | null>(null);
  useEffect(() => {
    api<{ workers: WorkerRow[] }>("/api/workers").then((r) => setWorkers(r.workers)).catch(() => setWorkers([]));
  }, []);
  if (!workers) return null;
  return (
    <section id="rendering" className="card mt-4 scroll-mt-4 space-y-2 p-4 text-sm" aria-labelledby="rendering-h" data-testid="rendering">
      <h2 id="rendering-h" className="font-medium">Rendering</h2>
      {!workers.length && <p className="text-warn">No render worker is running. Start it with <code>scripts/dev-worker.sh start</code>; drafts and exports wait until one is up.</p>}
      {workers.map((w) => (
        <p key={w.id} className="text-dim">
          <span className="text-ink">{w.id}</span> ·{" "}
          {w.gpu === "hardware" ? <span className="text-ok">uses the graphics chip</span> : <span>software rendering{w.gpuMode === "software" ? " (forced by RENDER_GPU=software)" : " (no graphics chip found)"}</span>}
          {" · "}Redraw {w.redraw ? "available" : "not installed"}
        </p>
      ))}
      <p className="text-faint">Graphics-heavy exports (Redraw layers) are much faster on a graphics chip. On a Mac this is detected automatically; set <code>RENDER_GPU=software</code> on the worker for bit-for-bit reproducible renders.</p>
    </section>
  );
}

type Check = { id: string; label: string; state: "ok" | "warn" | "missing" | "optional"; detail: string; href: string; required?: boolean };

/**
 * First-run checklist: what's ready and what's missing for a first real video, from the same
 * live state the sections below show (nothing is stored or guessed). Required: Claude and a
 * render worker. Everything else unlocks a feature and is optional.
 */
function GetStarted({ providers }: { providers: P[] }) {
  const [claude] = useClaudeStatus();
  const [workers, setWorkers] = useState<WorkerRow[] | null>(null);
  const [voices, setVoices] = useState<number | null>(null);
  useEffect(() => {
    api<{ workers: WorkerRow[] }>("/api/workers").then((r) => setWorkers(r.workers)).catch(() => setWorkers([]));
    api<{ voices: unknown[] }>("/api/voices").then((r) => setVoices(r.voices.length)).catch(() => setVoices(0));
  }, []);
  if (!claude || !workers || voices === null || !providers.length) return <section className="card mb-4 p-4 text-sm text-dim">Checking your setup…</section>;
  const prov = (id: string) => providers.find((p) => p.provider === id);
  const has = (id: string, key?: string) => !!prov(id)?.configured && (!key || !!(prov(id)?.settings as Record<string, unknown> | undefined)?.[key]);
  const checks: Check[] = [
    {
      id: "claude", label: "Claude", required: true, href: "#claude",
      state: claude.readiness.available ? "ok" : "missing",
      detail: claude.readiness.available ? `Ready (${claude.readiness.mode === "api" ? "API key" : "your Claude plan"}). Writes scripts, plans storyboards, edits and reviews.` : `${claude.readiness.message}${claude.readiness.recovery ? ` ${claude.readiness.recovery}` : ""}`,
    },
    {
      id: "worker", label: "Render worker", required: true, href: "#rendering",
      state: !workers.length ? "missing" : workers.some((w) => w.gpu === "hardware") ? "ok" : "warn",
      detail: !workers.length ? "No worker is running, so nothing can render. Start it with scripts/dev-worker.sh start." : workers.some((w) => w.gpu === "hardware") ? "Running and using the graphics chip." : "Running on software rendering: everything works, graphics-heavy exports are slower.",
    },
    {
      id: "voice", label: "Voiceover", href: "#provider-elevenlabs",
      state: has("elevenlabs") || has("omnivoice") ? "ok" : voices > 0 ? "warn" : "missing",
      detail: has("elevenlabs") || has("omnivoice") ? `Natural voices via ${[has("elevenlabs") && "ElevenLabs", has("omnivoice") && "OmniVoice"].filter(Boolean).join(" and ")}.` : voices > 0 ? `${voices} basic built-in voice${voices > 1 ? "s" : ""} only. Add an ElevenLabs key or an OmniVoice server for natural narration.` : "No voices: add an ElevenLabs key or an OmniVoice server to narrate.",
    },
    {
      id: "images", label: "Generated images", href: "#provider-openrouter",
      state: has("fal", "image") || has("openrouter", "image") || has("codex") ? "ok" : "optional",
      detail: has("fal", "image") || has("openrouter", "image") || has("codex") ? "Image shots and keyframes can be generated (within each project's budget)." : "Optional: add OpenRouter or fal with an image model, or turn on Images with ChatGPT, to generate stills and animatic keyframes.",
    },
    {
      id: "video", label: "Generated video", href: "#provider-fal",
      state: has("fal", "video") ? "ok" : "optional",
      detail: has("fal", "video") ? "Video shots can be generated after the animatic is approved." : "Optional: add a fal key with a video model to generate footage. Supplied footage always works.",
    },
    {
      id: "suggestions", label: "Instant suggestions", href: "#provider-jev",
      state: has("jev") ? "ok" : "optional",
      detail: has("jev") ? "Jev suggests a template, orientation, length and style while you type a new project." : "Optional: a Jev key adds instant suggestions while you type a new project.",
    },
    {
      id: "music", label: "Generated music", href: "#provider-elevenlabs",
      state: has("elevenlabs") ? "ok" : "optional",
      detail: has("elevenlabs") ? "Music beds can be composed with ElevenLabs (budget-gated)." : "Optional: an ElevenLabs key also composes music. Your own tracks always work.",
    },
  ];
  const ready = checks.filter((c) => c.required).every((c) => c.state === "ok" || c.state === "warn");
  const icon = { ok: "✓", warn: "!", missing: "✕", optional: "○" } as const;
  const tone = { ok: "text-ok", warn: "text-warn", missing: "text-bad", optional: "text-faint" } as const;
  return (
    <section className="card mb-4 space-y-3 p-4 text-sm" aria-labelledby="start-h" data-testid="get-started">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="start-h" className="font-medium">Get started</h2>
        <span className={`chip ${ready ? "text-ok" : "text-warn"}`} data-testid="setup-ready">{ready ? "Ready for your first video" : "Setup needed"}</span>
      </div>
      <ul className="space-y-1.5">
        {checks.map((c) => (
          <li key={c.id} className="flex gap-2" data-check={c.id} data-state={c.state}>
            <span aria-hidden className={`w-4 shrink-0 text-center font-semibold ${tone[c.state]}`}>{icon[c.state]}</span>
            <span className="min-w-0">
              <a href={c.href} className="font-medium hover:underline">{c.label}</a>
              {c.required && <span className="text-faint"> · required</span>}
              <span className="text-dim"> — {c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      {ready && <p className="text-faint">Next: open <a className="underline" href="/projects/new">New project</a>, describe your video, and follow the steps bar in the editor. Set a small budget in the project before generating anything paid.</p>}
    </section>
  );
}

type JevForm = { baseUrl?: string; model?: string };

/** Jev's address and model: the official API is TypeSafe's; a key from a Jev community hub may need that hub's address. */
function JevSettingsForm({ settings, onSave }: { settings: JevForm; onSave: (s: JevForm) => void }) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? "https://api.typesafe.ai");
  const [model, setModel] = useState(settings.model ?? "jev-latest");
  return (
    <form
      className="mt-3 grid grid-cols-1 gap-2 border-t border-line pt-3 text-xs sm:grid-cols-2"
      aria-label="Jev settings"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ baseUrl: baseUrl.trim(), model: model.trim() });
      }}
    >
      <p className="text-faint sm:col-span-2">Jev answers small decisions in well under a second. Fluxtify uses it only for suggestions you can ignore, such as the template, orientation, length and writing style while you type a new project; Claude still writes and plans everything. Use the address that issued your key: TypeSafe&apos;s official API by default, or a Jev community hub&apos;s.</p>
      <label className="flex flex-col gap-1">API address<input className="input" aria-label="Jev API address" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
      <label className="flex flex-col gap-1">Model<input className="input" aria-label="Jev model" value={model} onChange={(e) => setModel(e.target.value)} /></label>
      <button className="btn sm:col-span-2">Save Jev settings</button>
    </form>
  );
}

/** Lanternist's MCP address: where Fluxtify sends shot plans (the token goes in the key field above). */
function LanternistSettingsForm({ settings, onSave }: { settings: { mcpUrl?: string }; onSave: (s: { mcpUrl: string }) => void }) {
  const [mcpUrl, setMcpUrl] = useState(settings.mcpUrl ?? "https://lanternist.app/mcp");
  return (
    <form
      className="mt-3 grid grid-cols-1 gap-2 border-t border-line pt-3 text-xs"
      aria-label="Lanternist settings"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ mcpUrl: mcpUrl.trim() });
      }}
    >
      <p className="text-faint">Send to Lanternist (Export tab) turns a project&apos;s shot plan into a Lanternist film for storyboarding and client review. Use the MCP server address and access token from Lanternist&apos;s settings for connecting an assistant.</p>
      <label className="flex flex-col gap-1">MCP server address<input className="input" aria-label="Lanternist MCP address" value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} /></label>
      <button className="btn">Save Lanternist address</button>
    </form>
  );
}

type ShareForm = { endpoint?: string; bucket?: string; region?: string; accessKeyId?: string; publicBaseUrl?: string; linkDays?: number };

/** Picture hosting: the owner's S3-compatible bucket (the secret access key goes in the key field above). */
function ShareSettingsForm({ settings, onSave }: { settings: ShareForm; onSave: (s: Required<ShareForm>) => void }) {
  const [f, setF] = useState({ endpoint: settings.endpoint ?? "", bucket: settings.bucket ?? "", region: settings.region ?? "auto", accessKeyId: settings.accessKeyId ?? "", publicBaseUrl: settings.publicBaseUrl ?? "", linkDays: String(settings.linkDays ?? 7) });
  const field = (k: keyof typeof f, label: string, placeholder = "") => (
    <label className="flex flex-col gap-1">
      {label}
      <input className="input" aria-label={`Picture hosting ${label.toLowerCase()}`} placeholder={placeholder} value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} />
    </label>
  );
  return (
    <form
      className="mt-3 grid grid-cols-1 gap-2 border-t border-line pt-3 text-xs sm:grid-cols-2"
      aria-label="Picture hosting settings"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ endpoint: f.endpoint.trim(), bucket: f.bucket.trim(), region: f.region.trim() || "auto", accessKeyId: f.accessKeyId.trim(), publicBaseUrl: f.publicBaseUrl.trim(), linkDays: Math.min(7, Math.max(1, Number(f.linkDays) || 7)) });
      }}
    >
      <p className="text-faint sm:col-span-2">
        Lanternist only takes pictures by web address, so Fluxtify uploads the frames you send to your own bucket (Cloudflare R2, AWS S3, Backblaze B2, MinIO…) under unguessable names. Use a bucket and key for this alone: the key needs to put and read objects in it. Without a public address, links are signed and stop working after the days below. Anyone with a link can see that picture. Paste the secret access key in the key field above.
      </p>
      {field("endpoint", "S3 address", "https://<account>.r2.cloudflarestorage.com (empty for AWS)")}
      {field("bucket", "Bucket", "fluxtify-share")}
      {field("region", "Region", "auto")}
      {field("accessKeyId", "Access key ID")}
      {field("publicBaseUrl", "Public address (optional)", "https://pictures.example.com")}
      {field("linkDays", "Signed links last (days, 1–7)")}
      <button className="btn sm:col-span-2">Save picture hosting</button>
    </form>
  );
}
