"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { FootageSearch } from "@/components/FootageSearch";
import { api, ApiError, uploadFile, waitForJob } from "@/lib/client/api";

interface A {
  id: string;
  kind: string;
  status: string;
  name: string;
  bytes: number | null;
  media: { width?: number; height?: number; durationSec?: number; font?: { family: string } };
  isSample: boolean;
  generated: boolean;
  provenance: Record<string, unknown>;
  error: string | null;
  thumbUrl: string | null;
  previewUrl: string | null;
  downloadUrl: string | null;
  peaks: number[] | null;
}

export default function Assets() {
  const [assets, setAssets] = useState<A[]>([]);
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [rights, setRights] = useState(false);
  const [uploads, setUploads] = useState<Record<string, string>>({});
  const [sel, setSel] = useState<{ asset: A; usage: { projects: { id: string; title: string }[]; templates: { templateId: string; version: number }[] } } | null>(null);
  const [refs, setRefs] = useState<A[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const load = useCallback(() => api<{ assets: A[] }>(`/api/assets?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(q ? { q } : {}) })}`).then((r) => setAssets(r.assets)), [kind, q]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-xl font-semibold">Assets</h1>
        <select className="input w-auto" aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All kinds</option>
          {["image", "svg", "video", "audio", "font"].map((k) => <option key={k}>{k}</option>)}
        </select>
        <input className="input w-48" placeholder="Search by name" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="ml-auto flex items-center gap-1.5 text-xs text-dim">
          <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} /> I have the rights to use these files
        </label>
        <button className="btn btn-primary" disabled={!rights} onClick={() => input.current?.click()}>Upload files</button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={async (e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            await Promise.all(
              files.map(async (f) => {
                try {
                  await uploadFile(f, { rightsAcknowledged: rights, onProgress: (p, s) => setUploads((u) => ({ ...u, [f.name]: s === "uploading" ? `${Math.round(p * 100)}%` : s })) });
                  setUploads((u) => ({ ...u, [f.name]: "done" }));
                } catch (x) {
                  setUploads((u) => ({ ...u, [f.name]: `failed: ${x instanceof ApiError ? x.message : String(x)}` }));
                }
              }),
            );
            await load();
          }}
        />
      </div>
      <form
        className="mb-3 flex flex-wrap items-center gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const url = String(new FormData(e.currentTarget).get("shot") ?? "").trim();
          if (!url) return;
          setUploads((u) => ({ ...u, [url]: "capturing…" }));
          try {
            const r = await api<{ job: { id: string } }>("/api/assets/screenshot", { method: "POST", idempotent: true, json: { url } });
            const done = await waitForJob(r.job.id, (j) => setUploads((u) => ({ ...u, [url]: j.stage })));
            if (done.status !== "succeeded") throw new ApiError(422, done.error?.code ?? "failed", done.error?.message ?? "Capture failed.");
            const blocked = (done.result as { blocked?: unknown[] }).blocked?.length ?? 0;
            setUploads((u) => ({ ...u, [url]: `captured${blocked ? ` (${blocked} request(s) to non-public addresses were blocked)` : ""}` }));
            await load();
          } catch (x) {
            setUploads((u) => ({ ...u, [url]: `failed: ${x instanceof ApiError ? x.message : String(x)}` }));
          }
        }}
      >
        <input name="shot" type="url" className="input w-80" placeholder="https://… public page to capture" aria-label="Capture a public web page" />
        <button className="btn">Capture screenshot</button>
        <span className="text-xs text-faint">Public pages only; the capture keeps the address and date. Public availability is not a usage right.</span>
      </form>
      <GenerateImage refs={refs} onRemoveRef={(id) => setRefs((r) => r.filter((x) => x.id !== id))} onGenerated={() => void load()} />
      <details className="card mb-3 p-3" id="footage">
        <summary className="cursor-pointer text-sm font-medium">Find free footage and images (Internet Archive, Wikimedia Commons, Pexels, Pixabay, Moving Image Archive)</summary>
        <div className="mt-3">
          <FootageSearch onImported={() => void load()} />
        </div>
      </details>
      <p className="mb-4 text-xs text-faint">Limits: 500 MB per file, 10 minutes per source recording. Files are checked by their contents, not their extension. Identical files are stored once.</p>
      {Object.keys(uploads).length > 0 && (
        <ul className="card mb-4 p-3 text-xs" aria-live="polite">
          {Object.entries(uploads).map(([n, s]) => <li key={n}>{n}: {s}</li>)}
        </ul>
      )}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {assets.map((a) => (
          <li key={a.id}>
            <button className="card w-full overflow-hidden text-left transition-colors hover:border-accent/50" onClick={() => api<NonNullable<typeof sel>>(`/api/assets/${a.id}`).then(setSel)}>
              <div className="relative flex aspect-video items-center justify-center bg-bg text-xs text-faint">
                {a.thumbUrl ? (
                  <img src={a.thumbUrl} alt="" className="h-full w-full object-contain" />
                ) : a.kind === "audio" && a.peaks ? (
                  <div className="h-full w-full px-2 py-3 text-accent/80"><Wave peaks={a.peaks} /></div>
                ) : (
                  <span className="rounded border border-line px-2 py-0.5 text-[10px] uppercase tracking-wider">{a.status === "failed" ? `${a.kind} · failed` : a.status === "ready" ? a.kind : `${a.kind} · ${a.status}`}</span>
                )}
                {typeof a.media?.durationSec === "number" && (
                  <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] tabular-nums text-white">{fmtSec(a.media.durationSec)}</span>
                )}
              </div>
              <div className="p-2">
                <div className="truncate text-xs">{a.name}</div>
                <div className="flex flex-wrap gap-1 pt-1">
                  {a.isSample && <span className="sample-badge">Sample</span>}
                  {a.generated && <span className="chip">Generated</span>}
                  {a.status !== "ready" && <span className={`chip ${a.status === "failed" ? "text-bad" : ""}`}>{a.status}</span>}
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
      {sel && (
        <section className="card mt-6 p-4 text-sm" aria-label="Asset details">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="font-medium">{sel.asset.name}</h2>
            <button className="btn btn-ghost ml-auto text-xs" onClick={() => setSel(null)}>Close</button>
          </div>
          {sel.asset.kind === "video" && sel.asset.previewUrl && <video src={sel.asset.previewUrl} controls className="mb-2 max-h-72" />}
          {sel.asset.kind === "audio" && sel.asset.downloadUrl && <audio src={sel.asset.previewUrl ?? undefined} controls className="mb-2 w-full" />}
          <dl className="grid grid-cols-[120px_1fr] gap-1 text-xs">
            <dt className="text-faint">Kind</dt><dd>{sel.asset.kind}</dd>
            <dt className="text-faint">Size</dt><dd>{sel.asset.bytes ? `${(sel.asset.bytes / 1024 / 1024).toFixed(2)} MB` : "—"}</dd>
            <dt className="text-faint">Media</dt><dd>{describeMedia(sel.asset.media) || "—"}</dd>
            {sel.asset.provenance.source === "footage" && (
              <>
                <dt className="text-faint">Licence</dt>
                <dd>
                  {String(sel.asset.provenance.license ?? "")}
                  {sel.asset.provenance.attributionRequired ? <span className="text-warn"> — credit required</span> : null}
                  {sel.asset.provenance.licenseConfirmedByOwner ? <span className="text-warn"> — no licence stated; you confirmed you checked it</span> : null}
                </dd>
                {typeof sel.asset.provenance.attribution === "string" && (<><dt className="text-faint">Credit line</dt><dd className="break-words">{sel.asset.provenance.attribution}</dd></>)}
                <dt className="text-faint">Source</dt>
                <dd><a className="text-accent underline" href={String(sel.asset.provenance.pageUrl)} target="_blank" rel="noreferrer noopener">{String(sel.asset.provenance.pageUrl)}</a></dd>
              </>
            )}
            <dt className="text-faint">Provenance</dt><dd className="break-all">{JSON.stringify(sel.asset.provenance)}</dd>
            <dt className="text-faint">Used in</dt>
            <dd>{sel.usage.projects.length ? sel.usage.projects.map((p) => p.title).join(", ") : "No projects"}{sel.usage.templates.length ? `; templates: ${sel.usage.templates.map((t) => `${t.templateId} v${t.version}`).join(", ")}` : ""}</dd>
            {sel.asset.error && (<><dt className="text-faint">Error</dt><dd className="text-bad">{sel.asset.error}</dd></>)}
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            {sel.asset.downloadUrl && <a className="btn text-xs" href={sel.asset.downloadUrl}>Download original</a>}
            {sel.asset.kind === "image" && sel.asset.status === "ready" && (
              <button className="btn text-xs" disabled={refs.length >= 3 || refs.some((r) => r.id === sel.asset.id)} onClick={() => setRefs((r) => [...r, sel.asset])}>
                {refs.some((r) => r.id === sel.asset.id) ? "Used as reference" : "Use as reference for ChatGPT image"}
              </button>
            )}
          </div>
        </section>
      )}
    </main>
  );
}

const ASPECTS = [
  ["16:9", "16:9 landscape"],
  ["9:16", "9:16 portrait"],
  ["1:1", "1:1 square"],
  ["4:5", "4:5 social"],
  ["3:2", "3:2 photo"],
  ["2:3", "2:3 poster"],
] as const;

/** Prompt-to-image with the owner's ChatGPT plan (Codex CLI). The result lands in the library. */
function GenerateImage({ refs, onRemoveRef, onGenerated }: { refs: A[]; onRemoveRef: (id: string) => void; onGenerated: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<string>("16:9");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState<string | null>(null);
  const follow = async (start: () => Promise<string>) => {
    setBusy(true);
    setPaused(null);
    setStatus("starting…");
    try {
      const id = await start();
      const done = await waitForJob(id, (j) => setStatus(j.stage));
      if (done.status === "paused") {
        setPaused(id);
        setStatus(`paused: ${done.error?.message ?? "ChatGPT usage limit reached."} ${done.error?.recovery ?? ""}`);
      } else if (done.status !== "succeeded") setStatus(`failed: ${done.error?.message ?? "Generation failed."}${done.error?.recovery ? ` ${done.error.recovery}` : ""}`);
      else {
        setStatus("done: added to your assets.");
        onGenerated();
      }
    } catch (x) {
      setStatus(`failed: ${x instanceof ApiError ? `${x.message}${x.recovery ? ` ${x.recovery}` : ""}` : String(x)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="card mb-3 space-y-2 p-3 text-sm"
      aria-label="Generate image with ChatGPT"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || prompt.trim().length < 3) return;
        void follow(async () => (await api<{ job: { id: string } }>("/api/assets/generate-image", { method: "POST", idempotent: true, json: { prompt, aspectRatio: aspect, referenceAssetIds: refs.map((x) => x.id) } })).job.id);
      }}
    >
      <div className="flex items-center gap-2">
        <h2 className="font-medium">Generate image with ChatGPT</h2>
        <span className="text-xs text-faint">Uses your ChatGPT plan through the Codex CLI, about a minute per image. <a className="underline" href="/settings">Settings</a></span>
      </div>
      <textarea className="input min-h-20 w-full" aria-label="Image prompt" placeholder="Describe the image: subject, setting, style, lighting…" maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select className="input w-auto" aria-label="Aspect ratio" value={aspect} onChange={(e) => setAspect(e.target.value)}>
          {ASPECTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {refs.length ? (
          refs.map((r) => (
            <span key={r.id} className="chip flex items-center gap-1">
              {r.thumbUrl && <img src={r.thumbUrl} alt="" className="h-5 w-8 rounded object-cover" />}
              <span className="max-w-32 truncate">{r.name}</span>
              <button type="button" aria-label={`Remove reference ${r.name}`} onClick={() => onRemoveRef(r.id)}>×</button>
            </span>
          ))
        ) : (
          <span className="text-faint">Optional: open an image below and choose &quot;Use as reference&quot; (up to 3).</span>
        )}
        <button className="btn btn-primary ml-auto" disabled={busy || prompt.trim().length < 3}>{busy ? "Generating…" : "Generate image"}</button>
      </div>
      {status && <p className="text-xs text-dim" role="status">{status}</p>}
      {paused && (
        <div className="flex gap-2">
          <button type="button" className="btn text-xs" disabled={busy} onClick={() => void follow(async () => (await api(`/api/jobs/${paused}/retry`, { method: "POST" }), paused))}>Resume</button>
          <button type="button" className="btn btn-ghost text-xs" disabled={busy} onClick={() => api(`/api/jobs/${paused}/cancel`, { method: "POST" }).then(() => (setPaused(null), setStatus("canceled.")))}>Cancel</button>
        </div>
      )}
    </form>
  );
}

function describeMedia(m: { width?: number; height?: number; durationSec?: number; font?: { family: string } } | null) {
  if (!m) return "";
  return [m.width && m.height ? `${m.width}×${m.height}` : "", typeof m.durationSec === "number" ? fmtSec(m.durationSec) : "", m.font?.family ?? ""].filter(Boolean).join(" · ");
}

function fmtSec(sec: number) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Wave({ peaks: raw }: { peaks: number[] }) {
  // Normalise so quiet recordings are still readable; the shape is what matters here.
  const max = Math.max(0.05, ...raw);
  const peaks = raw.map((p) => p / max);
  const n = peaks.length;
  return (
    <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" className="h-full w-full" aria-hidden>
      {peaks.map((p, i) => <rect key={i} x={i} y={50 - p * 48} width={0.8} height={Math.max(1, p * 96)} fill="currentColor" />)}
    </svg>
  );
}
