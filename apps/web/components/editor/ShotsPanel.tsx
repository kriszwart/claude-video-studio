"use client";
import { useCallback, useEffect, useState } from "react";
import type { Operation, ProjectDocument } from "@vs/domain";
import { AssetPicker } from "@/components/AssetPicker";
import { api, ApiError } from "@/lib/client/api";
import { DebouncedText } from "./fields";
import type { JobDTO } from "./types";

type Estimate = { kind: "known"; micros: number; basis: string } | { kind: "unknown"; reason: string };
type ShotRow = { index: number; sceneId: string; purpose: string; shot: NonNullable<ProjectDocument["scenes"][number]["shot"]>; estimate: Estimate; model: string | null; fitsBudget: boolean | null; budgetMessage: string | null };
type ShotsDTO = { animatic: { status: "pending" | "approved" } | null; keyframeEstimate: Estimate; keyframes: { sceneId: string; needsKeyframe: boolean; url: string | null }[]; providerConfigured: boolean; imageVia?: "openrouter" | "fal" | null; modelsConfigured: { image: boolean; video: boolean }; budget: { projectCeilingMicros: number; operationCeilingMicros: number; unknownPriceRequestsAuthorized: number }; totals: { committedMicros: number; unknownPriceRequestsUsed: number }; shots: ShotRow[]; ledger: { operationId: string; status: string; estimatedMicros: number | null; actualMicros: number | null; priceBasis: string | null }[] };
type AssetDTO = { id: string; name: string; generated: boolean; previewUrl: string | null; kind: string };

const usd = (m: number) => `$${(m / 1_000_000).toFixed(2)}`;

/** Shot list for footage-based templates (T7, P6): supply or generate each shot within a budget. */
export function ShotsPanel({ projectId, doc, jobs, apply }: { projectId: string; doc: ProjectDocument; jobs: JobDTO[]; apply: (ops: Operation[]) => Promise<boolean> }) {
  const [data, setData] = useState<ShotsDTO | null>(null);
  const [assets, setAssets] = useState<Record<string, AssetDTO>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const running = jobs.filter((j) => j.type === "generate_media" && ["queued", "running", "waiting_provider"].includes(j.status)).length;
  const load = useCallback(async () => {
    const d = await api<ShotsDTO>(`/api/projects/${projectId}/shots`);
    setData(d);
    const ids = [...new Set(d.shots.flatMap((s) => [...s.shot.candidates.map((c) => c.assetId), s.shot.acceptedAssetId, ...s.shot.referenceAssetIds].filter(Boolean) as string[]))];
    const all: Record<string, AssetDTO> = {};
    for (const kind of ["video", "image"]) for (const a of (await api<{ assets: AssetDTO[] }>(`/api/assets?kind=${kind}`)).assets) if (ids.includes(a.id)) all[a.id] = a;
    setAssets(all);
  }, [projectId]);
  useEffect(() => {
    void load().catch((e) => setMsg(String(e)));
  }, [load, doc, running]);
  if (!data) return <p className="text-xs text-dim">Loading shots…</p>;
  const pending = data.shots.filter((s) => s.shot.source === "generate" && s.shot.status !== "accepted");
  const known = pending.filter((s) => s.estimate.kind === "known").reduce((a, s) => a + (s.estimate.kind === "known" ? s.estimate.micros : 0), 0);
  const unknown = pending.filter((s) => s.estimate.kind === "unknown").length;
  const act = async (fn: () => Promise<unknown>) => {
    setMsg(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <div className="space-y-4 text-xs">
      <section className="card space-y-2 p-2.5" aria-labelledby="budget-h">
        <h3 id="budget-h" className="text-sm font-medium">Generation budget</h3>
        <label className="flex items-center gap-2">
          Asset policy
          <select className="input w-auto py-1 text-xs" aria-label="Asset policy" value={doc.acquisitionPolicy} onChange={(e) => void apply([{ op: "setAcquisitionPolicy", policy: e.target.value as ProjectDocument["acquisitionPolicy"] }])}>
            <option value="existing-only">Existing assets only</option>
            <option value="existing-plus-public">Existing + public references</option>
            <option value="generated-allowed">Generated media allowed (within budget)</option>
          </select>
        </label>
        {!data.providerConfigured && <p className="text-warn">No generation provider is configured. Supply your own footage for each shot, or add a fal key (video and images) or an OpenRouter key (images) with a model in Settings.</p>}
        {data.imageVia && <p className="text-faint" data-testid="image-provider">Image shots use {data.imageVia === "openrouter" ? "OpenRouter" : "fal"}.</p>}
        {data.providerConfigured && !data.modelsConfigured.video && <p className="text-warn">No fal video model is configured (Settings → Providers).</p>}
        <BudgetForm projectId={projectId} budget={data.budget} onSaved={load} />
        <p className="text-dim">
          Committed so far: <strong>{usd(data.totals.committedMicros)}</strong> of {usd(data.budget.projectCeilingMicros)}
          {data.budget.unknownPriceRequestsAuthorized > 0 && ` · unknown-price requests used ${data.totals.unknownPriceRequestsUsed}/${data.budget.unknownPriceRequestsAuthorized}`}. Prices are owner-entered estimates; the provider's invoice is authoritative.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn text-xs" disabled={!pending.length || running > 0 || data.animatic?.status === "pending"} title={data.animatic?.status === "pending" ? "Approve the animatic first" : ""} onClick={() => act(() => api(`/api/projects/${projectId}/shots/generate`, { method: "POST", json: {}, idempotent: true }))}>
            {running ? `Generating ${running}…` : `Generate ${pending.length} missing shot(s)`}
          </button>
          {pending.length > 0 && <span className="text-faint">Estimate {usd(known)}{unknown ? ` + ${unknown} unknown-price request(s)` : ""}</span>}
        </div>
        {msg && <p role="alert" className="text-bad">{msg}</p>}
      </section>
      <AnimaticGate projectId={projectId} data={data} jobs={jobs} apply={apply} act={act} />
      <ol className="space-y-2" aria-label="Shots">
        {data.shots.map((s) => (
          <li key={s.sceneId} className="card space-y-2 p-2" data-testid={`shot-${s.index}`}>
            <div className="flex flex-wrap items-center gap-2">
              <strong>
                Shot {s.index}: {s.purpose}
              </strong>
              <span className={`chip ${s.shot.status === "failed" ? "text-bad" : s.shot.status === "accepted" ? "text-ok" : ""}`}>{s.shot.source === "supplied" ? "your footage" : s.shot.status}</span>
              {s.shot.autoAccepted && <span className="chip text-warn" title="The first result was placed automatically; review it">review</span>}
              <span className="ml-auto text-faint">{s.estimate.kind === "known" ? usd(s.estimate.micros) : "price unknown"}</span>
            </div>
            {s.shot.error && <p className="text-bad">{s.shot.error}</p>}
            {s.budgetMessage && s.shot.status !== "accepted" && <p className="text-warn">{s.budgetMessage}</p>}
            <DebouncedText multiline ariaLabel={`Prompt for shot ${s.index}`} value={s.shot.prompt} maxLength={1500} onCommit={(v) => apply([{ op: "updateShot", sceneId: s.sceneId, patch: { prompt: v } }])} />
            {s.shot.candidates.length > 0 && s.shot.referenceAssetIds[0] && assets[s.shot.referenceAssetIds[0]]?.previewUrl && (
              <figure className="w-28" data-testid="shot-reference">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={assets[s.shot.referenceAssetIds[0]]!.previewUrl!} alt="Approved reference" className="aspect-video w-full rounded object-contain bg-panel-2" />
                <figcaption className="text-[10px] text-faint">Approved reference</figcaption>
              </figure>
            )}
            {s.shot.candidates.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {s.shot.candidates.map((c) => {
                  const a = assets[c.assetId];
                  const accepted = s.shot.acceptedAssetId === c.assetId;
                  return (
                    <div key={c.assetId} className={`w-28 rounded border p-1 ${accepted ? "border-accent" : "border-line"}`}>
                      {a?.previewUrl ? a.kind === "video" ? <video src={a.previewUrl} muted loop playsInline className="aspect-video w-full rounded bg-black object-cover" onMouseEnter={(e) => void e.currentTarget.play()} /> : <img src={a.previewUrl} alt="" className="aspect-video w-full rounded object-cover" /> : <div className="aspect-video rounded bg-panel-2" />}
                      {c.review && (
                        <p className={`mt-1 text-[10px] ${c.review.decision === "rejected" ? "text-bad" : c.review.flagged ? "text-warn" : "text-faint"}`} title={c.review.method} data-testid="fidelity">
                          {c.review.decision === "rejected" ? "Rejected" : c.review.decision === "approved" ? "Approved by you" : c.review.flagged ? `Colour mismatch vs reference (${Math.round((c.review.paletteSimilarity ?? 0) * 100)}%) — review` : `Colour matches reference (${Math.round((c.review.paletteSimilarity ?? 0) * 100)}%)`}
                        </p>
                      )}
                      {c.review && c.review.decision === "pending" && (
                        <div className="flex gap-2 text-[10px]">
                          <button className="underline" onClick={() => apply([{ op: "reviewShotCandidate", sceneId: s.sceneId, assetId: c.assetId, decision: "approved" }])}>Matches</button>
                          <button className="underline text-bad" onClick={() => apply([{ op: "reviewShotCandidate", sceneId: s.sceneId, assetId: c.assetId, decision: "rejected" }])}>Reject</button>
                        </div>
                      )}
                      <div className="mt-1 flex items-center gap-1">
                        <span className="sample-badge" title="Generated media">Generated</span>
                        {!accepted && c.review?.decision !== "rejected" && (
                          <button className="ml-auto underline" onClick={() => apply([{ op: "acceptShot", sceneId: s.sceneId, assetId: c.assetId, supplied: false }])}>
                            Use
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {s.shot.source === "generate" && (
                <button className="btn btn-ghost px-2 py-0.5 text-[11px]" disabled={running > 0} title="Creates a new, separately billed request; the current shot is kept until you choose" onClick={() => act(() => api(`/api/projects/${projectId}/shots/generate`, { method: "POST", json: { sceneIds: [s.sceneId], regenerate: true }, idempotent: true }))}>
                  {s.shot.candidates.length ? "Regenerate" : "Generate"}
                </button>
              )}
              <details>
                <summary className="cursor-pointer">Use my own footage</summary>
                <div className="mt-1">
                  <AssetPicker kind={s.shot.kind === "image" ? "image" : "video"} value={s.shot.source === "supplied" && s.shot.acceptedAssetId ? [s.shot.acceptedAssetId] : []} onChange={(ids) => ids[0] && apply([{ op: "acceptShot", sceneId: s.sceneId, assetId: ids[0], supplied: true }])} />
                </div>
              </details>
            </div>
          </li>
        ))}
      </ol>
      {data.ledger.length > 0 && (
        <details className="card p-2">
          <summary className="cursor-pointer">Spend ledger ({data.ledger.length})</summary>
          <ul className="mt-2 space-y-1">
            {data.ledger.map((l) => (
              <li key={l.operationId} className="flex gap-2">
                <span className="chip">{l.status}</span>
                <span>{l.actualMicros !== null ? usd(l.actualMicros) : l.estimatedMicros !== null ? `~${usd(l.estimatedMicros)}` : "unknown"}</span>
                <span className="truncate text-faint" title={l.priceBasis ?? ""}>{l.priceBasis}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function BudgetForm({ projectId, budget, onSaved }: { projectId: string; budget: ShotsDTO["budget"]; onSaved: () => void }) {
  const [p, setP] = useState((budget.projectCeilingMicros / 1_000_000).toFixed(2));
  const [o, setO] = useState((budget.operationCeilingMicros / 1_000_000).toFixed(2));
  const [u, setU] = useState(String(budget.unknownPriceRequestsAuthorized));
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="grid grid-cols-3 gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        try {
          await api(`/api/projects/${projectId}/budget`, { method: "PUT", json: { projectCeilingMicros: Math.round(Number(p) * 1_000_000), operationCeilingMicros: Math.round(Number(o) * 1_000_000), unknownPriceRequestsAuthorized: Math.round(Number(u)) } });
          onSaved();
        } catch (x) {
          setErr(x instanceof ApiError ? x.message : String(x));
        }
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-faint">Project ceiling ($)</span>
        <input className="input" inputMode="decimal" value={p} onChange={(e) => setP(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-faint">Per shot ($)</span>
        <input className="input" inputMode="decimal" value={o} onChange={(e) => setO(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-faint">Unknown-price requests</span>
        <input className="input" inputMode="numeric" value={u} onChange={(e) => setU(e.target.value)} />
      </label>
      <button className="btn col-span-3 text-xs">Save budget</button>
      {err && <p className="col-span-3 text-bad">{err}</p>}
    </form>
  );
}

/**
 * Animatic first (Phase 4): keyframes for every video shot, played with the voiceover and music
 * as the draft render; paid video generation waits for the owner's approval of that animatic.
 */
function AnimaticGate({ projectId, data, jobs, apply, act }: { projectId: string; data: ShotsDTO; jobs: JobDTO[]; apply: (ops: Operation[]) => Promise<boolean>; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const shots = data.keyframes.filter((k) => k.needsKeyframe);
  if (!data.keyframes.length) return null;
  const missing = shots.filter((k) => !k.url);
  const done = shots.length - missing.length;
  const running = jobs.filter((j) => j.type === "generate_media" && ["queued", "running", "waiting_provider"].includes(j.status)).length;
  const rendering = jobs.find((j) => j.type === "preview" && ["queued", "running"].includes(j.status));
  const est = data.keyframeEstimate;
  const status = data.animatic?.status ?? null;
  return (
    <section className="card space-y-2 p-2.5" aria-label="Animatic">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Animatic first</h3>
        <span className={`chip ${status === "approved" ? "text-ok" : status === "pending" ? "text-warn" : ""}`} data-testid="animatic-status">{status === "approved" ? "approved" : status === "pending" ? "awaiting approval" : "no keyframes yet"}</span>
      </div>
      <p className="text-faint">Generate a still keyframe for each video shot, watch them timed to the voiceover and music, and approve before paying for video. Approved keyframes become each shot&apos;s first frame.</p>
      <ol className="space-y-1.5">
        <li className="flex flex-wrap items-center gap-2">
          <span className="text-dim">1. Keyframes {done}/{shots.length}</span>
          <button className="btn px-2 py-1 text-xs" disabled={!missing.length || running > 0} onClick={() => act(() => api(`/api/projects/${projectId}/shots/generate`, { method: "POST", json: { mode: "keyframes" }, idempotent: true }))}>
            {running ? `Generating ${running}…` : missing.length ? `Generate ${missing.length} keyframe${missing.length > 1 ? "s" : ""}` : "All keyframes ready"}
          </button>
          {missing.length > 0 && <span className="text-faint">{est.kind === "known" ? `about $${((est.micros * missing.length) / 1_000_000).toFixed(2)}` : `${missing.length} unknown-price request(s)`}</span>}
        </li>
        <li className="flex flex-wrap items-center gap-2">
          <span className="text-dim">2. Animatic</span>
          <button className="btn px-2 py-1 text-xs" disabled={done === 0 || !!rendering} onClick={() => act(() => api(`/api/projects/${projectId}/preview`, { method: "POST", json: {}, idempotent: true }))}>
            {rendering ? "Rendering…" : "Render the animatic"}
          </button>
          <span className="text-faint">A draft render: keyframes as stills with voiceover and music (no generation cost). Watch it in Rendered draft.</span>
        </li>
        <li className="flex flex-wrap items-center gap-2">
          <span className="text-dim">3. Approve</span>
          <button className="btn btn-primary px-2 py-1 text-xs" disabled={status !== "pending" || missing.length > 0} onClick={() => act(() => apply([{ op: "setAnimaticStatus", status: "approved" }]))}>
            {status === "approved" ? "Approved" : "Approve the animatic"}
          </button>
          <span className="text-faint">{status === "approved" ? "Video generation is unlocked. Changing a keyframe reopens approval." : "Unlocks video generation (the step that costs the most)."}</span>
        </li>
      </ol>
      {data.keyframes.some((k) => k.url) && (
        <div className="flex flex-wrap gap-1.5" aria-label="Keyframes">
          {data.keyframes.map((k, i) =>
            k.url ? (
              <figure key={k.sceneId} className="w-24">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={k.url} alt={`Keyframe for shot ${i + 1}`} className="aspect-video w-full rounded object-cover ring-1 ring-line" />
                <figcaption className="flex justify-between text-[10px] text-faint">
                  Shot {i + 1}
                  <button className="underline" aria-label={`Redo keyframe for shot ${i + 1}`} disabled={running > 0} onClick={() => act(() => api(`/api/projects/${projectId}/shots/generate`, { method: "POST", json: { mode: "keyframes", sceneIds: [k.sceneId], regenerate: true }, idempotent: true }))}>Redo</button>
                </figcaption>
              </figure>
            ) : null,
          )}
        </div>
      )}
    </section>
  );
}
