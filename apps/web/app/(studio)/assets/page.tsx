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
            <button className="card w-full overflow-hidden text-left" onClick={() => api<NonNullable<typeof sel>>(`/api/assets/${a.id}`).then(setSel)}>
              <div className="flex aspect-video items-center justify-center bg-bg text-xs text-faint">
                {a.thumbUrl ? <img src={a.thumbUrl} alt="" className="h-full w-full object-contain" /> : a.kind === "audio" && a.peaks ? <Wave peaks={a.peaks} /> : a.kind}
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
            <dt className="text-faint">Media</dt><dd>{JSON.stringify(sel.asset.media)}</dd>
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
          {sel.asset.downloadUrl && <a className="btn mt-3 text-xs" href={sel.asset.downloadUrl}>Download original</a>}
        </section>
      )}
    </main>
  );
}

function Wave({ peaks }: { peaks: number[] }) {
  const n = peaks.length;
  return (
    <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" className="h-full w-full" aria-hidden>
      {peaks.map((p, i) => <rect key={i} x={i} y={50 - p * 48} width={0.8} height={Math.max(1, p * 96)} fill="currentColor" />)}
    </svg>
  );
}
