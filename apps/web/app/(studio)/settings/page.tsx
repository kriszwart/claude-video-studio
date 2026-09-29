"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";

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
