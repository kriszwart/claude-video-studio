"use client";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { AssetPicker } from "@/components/AssetPicker";
import { api, ApiError, fmtBytes, fmtDuration, uploadToCollection, waitForJob } from "@/lib/client/api";

interface Item {
  id: string;
  sourceName: string;
  bytes: number | null;
  durationSec: number | null;
  status: string;
  error: string | null;
  transcriptId: string | null;
  assetId: string | null;
  asset: { kind: string; status: string; previewUrl: string | null; url: string | null } | null;
  job: { id: string; type: string; status: string; stage: string } | null;
}
interface View {
  collection: { id: string; name: string };
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };
  totals: { files: number; bytes: number; durationSec: number; indexedDurationSec: number; byStatus: Record<string, number> };
  importRoot: boolean;
  stt: { sttAvailable: boolean; sttPricePerHourMicros: number | null };
  items: Item[];
}
interface Plan {
  items: { id: string; sourceName: string; action: string; durationSec: number }[];
  sttMinutes: number;
  reuseMinutes: number;
  sidecarMinutes: number;
  estimatedCostMicros: number | null;
}
interface Hit {
  transcriptId: string;
  segmentId: string | null;
  assetId: string;
  sourceName: string;
  startSec: number;
  endSec: number;
  text: string;
  before: string;
  after: string;
  asset: { url: string | null; previewUrl: string | null } | null;
}
interface Seg {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
}
interface Pick {
  key: string;
  transcriptId: string;
  sourceName: string;
  assetUrl: string | null;
  segments: Seg[];
  theme: string;
  speaker: string;
}

const THEMES: [string, string][] = [
  ["energy", "Opening energy"],
  ["insight", "Speaker insight"],
  ["outcome", "Practical outcome"],
  ["reaction", "Audience reaction"],
  ["invitation", "Closing invitation"],
];
const ACTION_LABEL: Record<string, string> = {
  skip_indexed: "already indexed",
  reuse: "reuse existing transcript (same content)",
  sidecar: "import matching subtitles",
  transcribe: "transcribe",
  needs_transcript: "needs a transcript (no speech-to-text configured)",
  not_ready: "still processing",
  not_media: "not a recording",
};
const STATUS_TONE: Record<string, string> = { indexed: "text-emerald-400", failed: "text-red-400", needs_transcript: "text-amber-400" };

export default function CollectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rights, setRights] = useState(false);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<Plan | null>(null);
  const [q, setQ] = useState("");
  const [theme, setTheme] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [build, setBuild] = useState({ title: "", eventName: "", invitation: "", cta: "", logo: [] as string[], music: [] as string[] });
  const [building, setBuilding] = useState<string | null>(null);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setV(await api<View>(`/api/collections/${id}`));
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  // Poll while anything is processing.
  useEffect(() => {
    if (!v) return;
    const busy = v.items.some((i) => ["pending", "probing", "transcribing"].includes(i.status) || (i.job && ["queued", "running"].includes(i.job.status)));
    if (!busy) return;
    const t = setTimeout(load, 1500);
    return () => clearTimeout(t);
  }, [v, load]);

  async function addFiles(list: FileList | null) {
    const fs = [...(list ?? [])];
    for (const f of fs) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || undefined;
      try {
        const r = await uploadToCollection(id, f, { relativePath: rel, rightsAcknowledged: rights, onProgress: (p, s) => setProgress((x) => ({ ...x, [rel ?? f.name]: s === "uploading" ? `${Math.round(p * 100)}%` : s })) });
        setProgress((x) => ({ ...x, [rel ?? f.name]: r.skipped ? "already uploaded — skipped" : "uploaded" }));
      } catch (x) {
        setProgress((p) => ({ ...p, [rel ?? f.name]: `failed: ${x instanceof ApiError ? x.message : String(x)}` }));
      }
      await load();
    }
  }

  async function planIndex(all: boolean) {
    setErr(null);
    try {
      const r = await api<{ plan: Plan }>(`/api/collections/${id}/index`, { method: "POST", json: all ? { all: true, dryRun: true } : { itemIds: [...checked], dryRun: true } });
      setPlan(r.plan);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    }
  }
  async function startIndex() {
    if (!plan) return;
    await api(`/api/collections/${id}/index`, { method: "POST", json: { itemIds: plan.items.map((i) => i.id) } });
    setPlan(null);
    await load();
  }
  async function search(nextTheme = theme) {
    setErr(null);
    try {
      const r = await api<{ hits: Hit[] }>(`/api/collections/${id}/search?${new URLSearchParams({ ...(q ? { q } : {}), ...(nextTheme ? { theme: nextTheme } : {}) })}`);
      setHits(r.hits);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    }
  }
  function addPick(h: Hit) {
    if (!h.segmentId) return;
    const key = `${h.transcriptId}:${h.segmentId}`;
    if (picks.some((p) => p.key === key)) return;
    setPicks((p) => [...p, { key, transcriptId: h.transcriptId, sourceName: h.sourceName, assetUrl: h.asset?.url ?? null, segments: [{ id: h.segmentId!, startSec: h.startSec, endSec: h.endSec, text: h.text }], theme: theme || "", speaker: "" }]);
  }
  /** Extend a quote to the neighbouring sentence (continuous passages only). */
  async function extend(p: Pick, dir: -1 | 1) {
    const item = v?.items.find((i) => i.transcriptId === p.transcriptId);
    if (!item) return;
    const r = await api<{ transcript: { segments: Seg[] } | null }>(`/api/collections/${id}/items/${item.id}`);
    const segs = r.transcript?.segments ?? [];
    const first = segs.findIndex((s) => s.id === p.segments[0]!.id);
    const last = segs.findIndex((s) => s.id === p.segments.at(-1)!.id);
    const add = dir < 0 ? segs[first - 1] : segs[last + 1];
    if (!add) return;
    setPicks((all) => all.map((x) => (x.key === p.key ? { ...x, segments: dir < 0 ? [add, ...x.segments] : [...x.segments, add] } : x)));
  }
  async function buildReel() {
    setErr(null);
    setBuilding("queued");
    try {
      const { job } = await api<{ job: { id: string } }>(`/api/collections/${id}/sizzle`, {
        method: "POST",
        idempotent: true,
        json: {
          title: build.title || `${build.eventName} sizzle`,
          inputs: { eventName: build.eventName, invitation: build.invitation.split("\n").map((s) => s.trim()).filter(Boolean), cta: build.cta || undefined, logo: build.logo[0], music: build.music[0] },
          quotes: picks.map((p) => ({ transcriptId: p.transcriptId, segmentIds: p.segments.map((s) => s.id), theme: p.theme, speaker: p.speaker || undefined })),
        },
      });
      const done = await waitForJob(job.id, (j) => setBuilding(j.stage || j.status));
      if (done.status !== "succeeded") throw new ApiError(422, done.error?.code ?? "failed", done.error?.message ?? "The reel could not be built.");
      location.href = `/projects/${String(done.result?.projectId)}`;
    } catch (x) {
      setBuilding(null);
      setErr(x instanceof ApiError ? x.message : String(x));
    }
  }

  if (!v) return <main className="p-6 text-dim">{err ?? "Loading…"}</main>;
  const t = v.totals;
  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <h1 className="text-xl font-semibold">{v.collection.name}</h1>
      <p className="mb-4 text-sm text-dim" data-testid="collection-totals">
        {t.files} files · {fmtBytes(t.bytes)} of {fmtBytes(v.limits.maxTotalBytes)} · {fmtDuration(t.durationSec)} of source · {fmtDuration(t.indexedDurationSec)} indexed ·{" "}
        {Object.entries(t.byStatus).map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(", ") || "empty"}
      </p>
      {err && <p role="alert" className="mb-3 text-sm text-red-400">{err}</p>}

      <section className="card mb-6 p-4" aria-labelledby="rec-h">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 id="rec-h" className="mr-2 font-medium">Recordings</h2>
          <label className="flex items-center gap-1.5 text-xs text-dim">
            <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} /> I have the rights to use these recordings
          </label>
          <button className="btn" disabled={!rights} onClick={() => files.current?.click()}>Add files</button>
          <button className="btn" disabled={!rights} onClick={() => folder.current?.click()}>Add folder</button>
          <input ref={files} type="file" multiple hidden accept="video/*,audio/*,.srt,.vtt" onChange={(e) => void addFiles(e.target.files).then(() => (e.target.value = ""))} />
          <input ref={folder} type="file" multiple hidden {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(e) => void addFiles(e.target.files).then(() => (e.target.value = ""))} />
          <span className="ml-auto flex gap-2">
            <button className="btn" disabled={checked.size === 0} onClick={() => planIndex(false)}>Index selected ({checked.size})</button>
            <button className="btn" onClick={() => planIndex(true)}>Index all…</button>
          </span>
        </div>
        <p className="mb-2 text-xs text-faint">
          Limits: {v.limits.maxFiles} files, {fmtBytes(v.limits.maxFileBytes)} per file. Uploads resume after interruptions; re-adding the same folder skips files already uploaded. Matching .srt/.vtt files are used as transcripts. Speech-to-text: {v.stt.sttAvailable ? "available" : "not configured"}.
          {v.importRoot && " The server import folder is available to owners."}
        </p>
        {Object.keys(progress).length > 0 && (
          <ul className="mb-2 text-xs text-dim" aria-live="polite">
            {Object.entries(progress).map(([k, s]) => <li key={k}>{k}: {s}</li>)}
          </ul>
        )}
        {plan && (
          <div className="mb-3 rounded border border-line p-3 text-sm" role="dialog" aria-label="Indexing estimate">
            <p className="mb-1 font-medium">Indexing estimate</p>
            <ul className="mb-2 text-xs text-dim">
              {plan.items.map((i) => <li key={i.id}>{i.sourceName}: {ACTION_LABEL[i.action] ?? i.action} ({fmtDuration(i.durationSec)})</li>)}
            </ul>
            <p className="mb-2 text-xs">
              {plan.reuseMinutes.toFixed(1)} min reused · {plan.sidecarMinutes.toFixed(1)} min from subtitles · {plan.sttMinutes.toFixed(1)} min to transcribe ·{" "}
              {plan.estimatedCostMicros === null ? "cost: provider price not configured (set STT_PRICE_USD_PER_HOUR)" : `estimated cost $${(plan.estimatedCostMicros / 1e6).toFixed(2)}`}
            </p>
            <button className="btn btn-primary mr-2" onClick={startIndex}>Start indexing</button>
            <button className="btn btn-ghost" onClick={() => setPlan(null)}>Cancel</button>
          </div>
        )}
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-faint">
            <tr><th className="w-6" /><th>Recording</th><th>Size</th><th>Duration</th><th>Status</th></tr>
          </thead>
          <tbody>
            {v.items.map((i) => (
              <tr key={i.id} className="border-t border-line" data-testid="collection-item">
                <td>
                  <input type="checkbox" aria-label={`Select ${i.sourceName}`} checked={checked.has(i.id)} onChange={(e) => setChecked((c) => { const n = new Set(c); if (e.target.checked) n.add(i.id); else n.delete(i.id); return n; })} />
                </td>
                <td className="py-1">{i.sourceName}</td>
                <td>{i.bytes ? fmtBytes(Number(i.bytes)) : "—"}</td>
                <td>{i.durationSec ? fmtDuration(i.durationSec) : "—"}</td>
                <td className={STATUS_TONE[i.status] ?? "text-dim"}>
                  {/\.(srt|vtt)$/i.test(i.sourceName) && i.status === "uploaded" ? "subtitle file" : i.status.replace("_", " ")}
                  {i.job && ["queued", "running"].includes(i.job.status) ? ` · ${i.job.stage || i.job.status}` : ""}
                  {i.error ? <span className="block text-xs">{i.error}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <section className="card p-4" aria-labelledby="search-h">
          <h2 id="search-h" className="mb-2 font-medium">Find moments</h2>
          <form className="mb-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); setTheme(""); void search(""); }}>
            <input className="input" aria-label="Search transcripts" placeholder="Search what people said…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn">Search</button>
          </form>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {THEMES.map(([k, label]) => (
              <button key={k} className={`chip ${theme === k ? "bg-panel-2 text-ink" : ""}`} aria-pressed={theme === k} onClick={() => { setTheme(k); void search(k); }}>{label}</button>
            ))}
          </div>
          <p className="mb-2 text-xs text-faint">Themes are transparent keyword searches over the transcripts. Review each candidate: play the source and read the context.</p>
          {hits && hits.length === 0 && <p className="text-sm text-dim">No matching moments in indexed recordings.</p>}
          <ul className="space-y-3">
            {(hits ?? []).map((h) => (
              <li key={`${h.transcriptId}-${h.startSec}`} className="rounded border border-line p-3" data-testid="quote-candidate">
                <p className="text-xs text-faint">{h.sourceName} · {fmtDuration(h.startSec)}–{fmtDuration(h.endSec)}</p>
                <p className="text-sm"><span className="text-faint">{h.before} </span><strong>“{h.text}”</strong><span className="text-faint"> {h.after}</span></p>
                {h.asset?.url && <video className="mt-2 max-h-40 rounded" controls preload="none" src={`${h.asset.url}#t=${Math.max(0, h.startSec - 0.3).toFixed(2)},${(h.endSec + 0.3).toFixed(2)}`} aria-label={`Play source excerpt from ${h.sourceName}`} />}
                <button className="btn mt-2" onClick={() => addPick(h)} disabled={!h.segmentId}>Use this quote</button>
              </li>
            ))}
          </ul>
        </section>

        <section className="card p-4" aria-labelledby="reel-h">
          <h2 id="reel-h" className="mb-2 font-medium">Sizzle reel</h2>
          <p className="mb-2 text-xs text-faint">Order follows the recipe: opening energy → insight/outcome → reactions → invitation. Quotes play their full words with clean handles; music is lowered under voices.</p>
          <ol className="mb-3 space-y-2">
            {picks.map((p) => (
              <li key={p.key} className="rounded border border-line p-2 text-sm" data-testid="picked-quote">
                <p>“{p.segments.map((s) => s.text).join(" ")}”</p>
                <p className="text-xs text-faint">{p.sourceName} · {fmtDuration(p.segments[0]!.startSec)}–{fmtDuration(p.segments.at(-1)!.endSec)}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <select className="input w-auto text-xs" aria-label="Story role" value={p.theme} onChange={(e) => setPicks((all) => all.map((x) => (x.key === p.key ? { ...x, theme: e.target.value } : x)))}>
                    <option value="">(unassigned)</option>
                    {THEMES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  <input className="input w-28 text-xs" placeholder="Speaker (optional)" aria-label="Speaker credit" value={p.speaker} onChange={(e) => setPicks((all) => all.map((x) => (x.key === p.key ? { ...x, speaker: e.target.value } : x)))} />
                  <button className="btn btn-ghost text-xs" onClick={() => extend(p, -1)}>+ sentence before</button>
                  <button className="btn btn-ghost text-xs" onClick={() => extend(p, 1)}>+ after</button>
                  <button className="btn btn-ghost text-xs" onClick={() => setPicks((all) => all.filter((x) => x.key !== p.key))}>Remove</button>
                </div>
              </li>
            ))}
          </ol>
          <label className="mb-1 block text-xs">Event name<input className="input" value={build.eventName} onChange={(e) => setBuild({ ...build, eventName: e.target.value })} maxLength={60} /></label>
          <label className="mb-1 block text-xs">Next-event details (approved, one per line)<textarea className="input" rows={2} value={build.invitation} onChange={(e) => setBuild({ ...build, invitation: e.target.value })} /></label>
          <label className="mb-1 block text-xs">Call to action<input className="input" value={build.cta} onChange={(e) => setBuild({ ...build, cta: e.target.value })} maxLength={50} /></label>
          <div className="mb-1 text-xs">Logo (approved)<AssetPicker kind="image" value={build.logo} onChange={(ids) => setBuild({ ...build, logo: ids })} /></div>
          <div className="mb-2 text-xs">Music bed<AssetPicker kind="audio" value={build.music} onChange={(ids) => setBuild({ ...build, music: ids })} /></div>
          <button className="btn btn-primary w-full" disabled={!picks.length || !build.eventName.trim() || !!building} onClick={buildReel}>
            {building ? `Building… ${building}` : `Build sizzle reel (${picks.length} quotes)`}
          </button>
        </section>
      </div>
    </main>
  );
}
