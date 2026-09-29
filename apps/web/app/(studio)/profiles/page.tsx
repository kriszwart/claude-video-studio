"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AssetPicker } from "@/components/AssetPicker";
import { api, ApiError, waitForJob } from "@/lib/client/api";

interface Trait {
  field: string;
  value: unknown;
  basis: "measured" | "interpretation" | "not measured";
  detail: string;
  evidence: { timeSec?: number; assetId?: string; metric?: string }[];
}
interface P {
  id: string;
  name: string;
  latestVersion: number;
}

const BASIS_TONE = { measured: "text-emerald-400", interpretation: "text-amber-400", "not measured": "text-faint" } as const;

/** Creative profiles: editing taste learned only through explicit, reviewable steps (FR-17). */
export default function Profiles() {
  const [profiles, setProfiles] = useState<P[]>([]);
  const [ref, setRef] = useState<string[]>([]);
  const [stage, setStage] = useState<string | null>(null);
  const [traits, setTraits] = useState<Trait[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const load = () => api<{ profiles: P[] }>("/api/profiles").then((r) => setProfiles(r.profiles));
  useEffect(() => {
    void load();
  }, []);

  async function analyze() {
    setErr(null);
    setTraits(null);
    try {
      const { job } = await api<{ job: { id: string } }>("/api/profiles/analyze", { method: "POST", json: { assetId: ref[0] }, idempotent: true });
      const done = await waitForJob(job.id, (j) => setStage(j.stage));
      setStage(null);
      if (done.status !== "succeeded") throw new ApiError(422, "failed", done.error?.message ?? "Analysis failed.");
      const t = (done.result as { traits: Trait[] }).traits;
      setTraits(t);
      setPicked(new Set(t.map((x, i) => (x.basis === "measured" ? i : -1)).filter((i) => i >= 0)));
      const ids = [...new Set(t.flatMap((x) => x.evidence.map((e) => e.assetId).filter((a): a is string => !!a)))];
      const urls: Record<string, string> = {};
      for (const id of ids) urls[id] = (await api<{ asset: { url: string } }>(`/api/assets/${id}`)).asset.url;
      setThumbs(urls);
    } catch (x) {
      setStage(null);
      setErr(x instanceof ApiError ? x.message : String(x));
    }
  }
  async function save() {
    setErr(null);
    try {
      const r = await api<{ profile: { id: string } }>("/api/profiles", { method: "POST", json: { name, traits: traits!.filter((_, i) => picked.has(i)), sourceAssetId: ref[0] } });
      location.href = `/profiles/${r.profile.id}`;
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="mb-1 text-xl font-semibold">Creative profiles</h1>
      <p className="mb-4 text-sm text-dim">Editing taste — pacing, type scale, transitions, motion, sound density, framing — separate from your brand kit (identity) and templates (structure). Profiles change only when you save a new version; projects keep the version they were given.</p>
      {err && <p role="alert" className="mb-3 text-sm text-red-400">{err}</p>}
      <ul className="mb-6 grid gap-2 sm:grid-cols-3">
        {profiles.map((p) => (
          <li key={p.id} className="card p-3">
            <Link className="font-medium hover:underline" href={`/profiles/${p.id}`}>{p.name}</Link>
            <span className="ml-2 text-xs text-faint">v{p.latestVersion}</span>
          </li>
        ))}
        {profiles.length === 0 && <li className="text-sm text-dim">No saved profiles yet.</li>}
      </ul>

      <section className="card p-4" aria-labelledby="ref-h">
        <h2 id="ref-h" className="mb-2 font-medium">Create from a reference</h2>
        <p className="mb-2 text-xs text-faint">Upload a clip you have the right to analyse. Shot lengths, transitions, motion and sound are measured with timestamps; anything inferred is labelled as an interpretation. With screenshots only, motion and sound are not claimed.</p>
        <div className="mb-2 flex items-center gap-2">
          <AssetPicker kind="video" value={ref} onChange={setRef} />
          <button className="btn btn-primary" disabled={!ref.length || !!stage} onClick={analyze}>{stage ? `Analysing… ${stage}` : "Analyse reference"}</button>
        </div>
        {traits && (
          <>
            <table className="mb-3 w-full text-sm" aria-label="Proposed traits">
              <thead className="text-left text-xs text-faint">
                <tr><th className="w-6" /><th>Trait</th><th>Value</th><th>Basis</th><th>Evidence</th></tr>
              </thead>
              <tbody>
                {traits.map((t, i) => (
                  <tr key={i} className="border-t border-line align-top" data-testid="trait">
                    <td className="pt-1">
                      <input type="checkbox" aria-label={`Use ${t.field}`} disabled={t.basis !== "measured" || t.value === null} checked={picked.has(i)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(i); else n.delete(i); return n; })} />
                    </td>
                    <td className="py-1 pr-2">{t.field}</td>
                    <td className="pr-2">{t.value === null ? "—" : String(t.value)}</td>
                    <td className={`pr-2 ${BASIS_TONE[t.basis]}`}>{t.basis}</td>
                    <td className="text-xs text-dim">
                      {t.detail}
                      <div className="mt-1 flex flex-wrap gap-1">
                        {t.evidence.filter((e) => e.timeSec !== undefined && !e.assetId).slice(0, 8).map((e, k) => <span key={k} className="chip">{e.metric} @ {e.timeSec!.toFixed(2)}s</span>)}
                        {t.evidence.filter((e) => e.assetId && thumbs[e.assetId]).slice(0, 5).map((e) => (
                          <figure key={e.assetId} className="w-24">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={thumbs[e.assetId!]} alt={`Reference frame at ${e.timeSec?.toFixed(2)} s`} className="rounded" />
                            <figcaption className="text-[10px]">{e.timeSec?.toFixed(2)} s</figcaption>
                          </figure>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex gap-2">
              <input className="input max-w-xs" placeholder="Profile name, e.g. Calm Technical" aria-label="Profile name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
              <button className="btn btn-primary" disabled={!name.trim() || picked.size === 0} onClick={save}>Save selected traits as profile</button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
