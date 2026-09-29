"use client";
import { useEffect, useState } from "react";
import type { BrandSnapshot } from "@vs/domain";
import { AssetPicker } from "@/components/AssetPicker";
import { api, ApiError } from "@/lib/client/api";

interface Kit { id: string; name: string; version: number; data: BrandSnapshot }
const FAMILIES = ["Inter", "Space Grotesk", "DM Serif Display", "Caveat", "Bebas Neue"];
const blank = (): BrandSnapshot => ({
  name: "",
  colors: { primary: "#4f46e5", secondary: "#1e1b4b", accent: "#f59e0b", background: "#0b0d17", surface: "#171a2b", text: "#f8fafc", muted: "#64748b" },
  fonts: { heading: { family: "Space Grotesk", weight: 700 }, body: { family: "Inter", weight: 400 } },
  logoPlacement: "end-card-only",
  captionStyle: "boxed",
  tone: "",
  forbidden: [],
});

export default function BrandKits() {
  const [kits, setKits] = useState<Kit[]>([]);
  const [edit, setEdit] = useState<{ id?: string; name: string; data: BrandSnapshot } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fontAssets, setFontAssets] = useState<{ id: string; name: string; media: { font?: { family: string; weight: number } } }[]>([]);
  const load = () => api<{ brandKits: Kit[] }>("/api/brand-kits").then((r) => setKits(r.brandKits));
  useEffect(() => {
    void load();
    api<{ assets: typeof fontAssets }>("/api/assets?kind=font").then((r) => setFontAssets(r.assets));
  }, []);
  const save = async () => {
    if (!edit) return;
    setErr(null);
    try {
      if (edit.id) await api(`/api/brand-kits/${edit.id}`, { method: "PATCH", json: { name: edit.name, data: edit.data } });
      else await api("/api/brand-kits", { method: "POST", json: { name: edit.name, data: edit.data } });
      setEdit(null);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };
  const families = [...FAMILIES, ...fontAssets.map((f) => f.media.font?.family).filter((x): x is string => !!x)];
  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-4 flex items-center">
        <h1 className="text-xl font-semibold">Brand kits</h1>
        <button className="btn btn-primary ml-auto" onClick={() => setEdit({ name: "New brand kit", data: blank() })}>New brand kit</button>
      </div>
      <p className="mb-4 text-sm text-dim">Projects keep a snapshot of the kit they used. Updating a kit never silently changes existing projects; apply it from the editor to create a revision.</p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {kits.map((k) => (
          <li key={k.id} className="card p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="font-medium">{k.name}</span>
              <span className="text-xs text-faint">v{k.version}</span>
              <button className="btn btn-ghost ml-auto text-xs" onClick={() => setEdit({ id: k.id, name: k.name, data: k.data })}>Edit</button>
              <button className="btn btn-ghost text-xs text-bad" onClick={async () => { await api(`/api/brand-kits/${k.id}`, { method: "DELETE" }); await load(); }}>Archive</button>
            </div>
            <div className="flex gap-1">
              {Object.entries(k.data.colors).map(([n, c]) => <span key={n} title={n} className="h-6 w-6 rounded border border-line" style={{ background: c }} />)}
            </div>
            <p className="mt-2 text-xs text-dim">{k.data.fonts.heading.family} / {k.data.fonts.body.family}</p>
          </li>
        ))}
      </ul>
      {edit && (
        <section className="card mt-6 space-y-4 p-4" aria-label="Edit brand kit">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="kn">Name</label>
              <input id="kn" className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value, data: { ...edit.data, name: e.target.value } })} />
            </div>
            <div>
              <label className="label" htmlFor="tone">Tone of voice</label>
              <input id="tone" className="input" value={edit.data.tone} onChange={(e) => setEdit({ ...edit, data: { ...edit.data, tone: e.target.value } })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Object.entries(edit.data.colors).map(([n, c]) => (
              <label key={n} className="text-xs">
                <span className="label capitalize">{n}</span>
                <input type="color" value={c.slice(0, 7)} onChange={(e) => setEdit({ ...edit, data: { ...edit.data, colors: { ...edit.data.colors, [n]: e.target.value } } })} className="h-8 w-full rounded border border-line bg-transparent" />
              </label>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["heading", "body"] as const).map((r) => (
              <label key={r} className="text-xs">
                <span className="label capitalize">{r} font</span>
                <select className="input" value={edit.data.fonts[r].family} onChange={(e) => {
                  const fa = fontAssets.find((f) => f.media.font?.family === e.target.value);
                  setEdit({ ...edit, data: { ...edit.data, fonts: { ...edit.data.fonts, [r]: { family: e.target.value, weight: fa?.media.font?.weight ?? edit.data.fonts[r].weight, assetId: fa?.id } } } });
                }}>
                  {families.map((f) => <option key={f}>{f}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div>
            <span className="label">Upload a font (TTF, OTF, WOFF, WOFF2)</span>
            <AssetPicker kind="font" value={[]} onChange={() => api<{ assets: typeof fontAssets }>("/api/assets?kind=font").then((r) => setFontAssets(r.assets))} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <span className="label">Logo</span>
              <AssetPicker kind="image" value={edit.data.logoAssetId ? [edit.data.logoAssetId] : []} onChange={(ids) => setEdit({ ...edit, data: { ...edit.data, logoAssetId: ids[0] } })} />
            </div>
            <label className="text-xs">
              <span className="label">Logo placement</span>
              <select className="input" value={edit.data.logoPlacement} onChange={(e) => setEdit({ ...edit, data: { ...edit.data, logoPlacement: e.target.value as BrandSnapshot["logoPlacement"] } })}>
                <option value="end-card-only">End card only</option>
                <option value="top-right">Every scene, top right</option>
                <option value="top-left">Every scene, top left</option>
                <option value="bottom-right">Every scene, bottom right</option>
                <option value="bottom-left">Every scene, bottom left</option>
              </select>
            </label>
          </div>
          <label className="block text-xs">
            <span className="label">Forbidden treatments (one per line)</span>
            <textarea className="input" value={edit.data.forbidden.join("\n")} onChange={(e) => setEdit({ ...edit, data: { ...edit.data, forbidden: e.target.value.split("\n").filter(Boolean).slice(0, 20) } })} />
          </label>
          {err && <p role="alert" className="text-sm text-bad">{err}</p>}
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={save}>Save</button>
            <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </section>
      )}
    </main>
  );
}
