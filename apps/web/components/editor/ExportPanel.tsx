"use client";
import { useEffect, useMemo, useState } from "react";
import type { ProjectDocument } from "@vs/domain";
import { api, ApiError, fmtDuration } from "@/lib/client/api";
import type { ExportDTO, JobDTO } from "./types";

export function ExportPanel({ projectId, doc, revisionId, exports, jobs, blocking }: { projectId: string; doc: ProjectDocument; revisionId: string; exports: ExportDTO[]; jobs: JobDTO[]; blocking: boolean }) {
  const [err, setErr] = useState<string | null>(null);
  const running = jobs.find((j) => j.type === "export" && ["queued", "running", "cancel_requested"].includes(j.status));
  const finals = exports.filter((e) => e.kind === "final");
  const [showTpl, setShowTpl] = useState(false);
  return (
    <div className="space-y-4">
      <Credits projectId={projectId} revisionId={revisionId} />
      <OtioExport projectId={projectId} revisionId={revisionId} exports={exports} jobs={jobs} />
      <div>
        <button
          className="btn btn-primary"
          disabled={!!running || blocking}
          onClick={async () => {
            setErr(null);
            try {
              await api(`/api/projects/${projectId}/exports`, { method: "POST", idempotent: true, json: { revisionId } });
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : String(e));
            }
          }}
        >
          {running ? "Exporting…" : "Export final MP4 (1080p, H.264/AAC)"}
        </button>
        {running && (
          <p className="mt-1 text-xs text-dim" aria-live="polite">
            {running.status === "queued" ? "Queued" : running.stage}
            {running.progress != null && running.status === "running" ? ` · ${Math.round(running.progress * 100)}%` : ""} — pinned to revision {revisionId.slice(-6)}; you can keep editing.
          </p>
        )}
        {err && <p role="alert" className="mt-1 text-xs text-bad">{err}</p>}
      </div>
      <ul className="space-y-2">
        {finals.length === 0 && <li className="text-xs text-faint">No final exports yet.</li>}
        {finals.map((e) => (
          <li key={e.id} className="card p-2.5 text-xs">
            <div className="flex gap-2">
              {e.thumbUrl && <img src={e.thumbUrl} alt="" className="h-12 w-20 rounded object-cover" />}
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {e.width}×{e.height} · {fmtDuration(e.durationSec)}
                </div>
                <div className="text-faint">
                  {new Date(e.createdAt).toLocaleString()} · revision {e.revisionId.slice(-6)} {e.revisionId === revisionId ? "(current)" : "(older revision)"}
                </div>
                {e.loudness && (
                  <div className="text-faint">
                    Measured {e.loudness.lufs.toFixed(1)} LUFS · {e.loudness.truePeakDb.toFixed(1)} dBTP
                  </div>
                )}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <a className="btn text-xs" href={e.downloadUrl}>Download MP4</a>
              {e.srtUrl && <a className="btn text-xs" href={e.srtUrl}>SRT</a>}
              {e.vttUrl && <a className="btn text-xs" href={e.vttUrl}>VTT</a>}
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-faint">Verification ({e.checks.filter((c) => c.severity === "hard" && c.ok).length}/{e.checks.filter((c) => c.severity === "hard").length} checks passed)</summary>
              <ul className="mt-1 space-y-0.5">
                {e.checks.map((c) => (
                  <li key={c.name} className={c.ok ? (c.severity === "signal" ? "text-dim" : "text-ok") : "text-bad"}>
                    {c.ok ? "✓" : "✗"} {c.name}: {c.detail}
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
      <div className="border-t border-line pt-3">
        <button className="btn" onClick={() => setShowTpl(!showTpl)} aria-expanded={showTpl}>
          Save as reusable template…
        </button>
        {showTpl && <SaveTemplate projectId={projectId} doc={doc} />}
      </div>
    </div>
  );
}

function SaveTemplate({ projectId, doc }: { projectId: string; doc: ProjectDocument }) {
  const textLayers = useMemo(() => doc.scenes.flatMap((s, i) => s.layers.filter((l) => l.kind === "text").map((l) => ({ sceneId: s.id, layerId: l.id, label: `Scene ${i + 1} ${l.kind === "text" ? l.role : ""}`, text: l.kind === "text" ? l.text : "" }))), [doc]);
  const assetIds = useMemo(() => [...new Set([...doc.scenes.flatMap((s) => s.layers.flatMap((l) => ((l.kind === "image" || l.kind === "video") && l.assetId ? [l.assetId] : []))), ...doc.audio.map((a) => a.assetId)])], [doc]);
  const [vars, setVars] = useState<Set<string>>(() => new Set(textLayers.filter((t) => t.text.trim()).map((t) => `${t.sceneId}/${t.layerId}`)));
  const [include, setInclude] = useState<Set<string>>(new Set());
  const [name, setName] = useState(`${doc.title} template`);
  const [description, setDescription] = useState("");
  const [preview, setPreview] = useState<{ variables: { label: string; kind: string }[]; preview: { scenes: { purpose: string; texts: string[] }[] } } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const payload = (dryRun: boolean) => ({
    name,
    description,
    dryRun,
    textVariables: textLayers.filter((t) => vars.has(`${t.sceneId}/${t.layerId}`)).map((t) => ({ sceneId: t.sceneId, layerId: t.layerId, label: t.label })),
    includeAssetIds: [...include],
  });
  const call = async (dryRun: boolean) => {
    setErr(null);
    try {
      const r = await api<{ templateId?: string; version?: number; variables: { label: string; kind: string }[]; preview: { scenes: { purpose: string; texts: string[] }[] } }>(`/api/projects/${projectId}/template`, { method: "POST", json: payload(dryRun) });
      setPreview(r);
      if (!dryRun) setDone(`Saved as template ${r.templateId} v${r.version}.`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <div className="mt-3 space-y-3 text-xs">
      <div>
        <label className="label" htmlFor="tplname">Template name</label>
        <input id="tplname" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="tpldesc">Description</label>
        <input id="tpldesc" className="input" value={description} maxLength={600} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <fieldset>
        <legend className="label">Text that becomes a variable (current text is the default)</legend>
        <ul className="max-h-40 space-y-1 overflow-y-auto">
          {textLayers.map((t) => {
            const k = `${t.sceneId}/${t.layerId}`;
            return (
              <li key={k}>
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={vars.has(k)} onChange={(e) => setVars((v) => { const n = new Set(v); if (e.target.checked) n.add(k); else n.delete(k); return n; })} />
                  <span><span className="text-faint">{t.label}:</span> {t.text || <em className="text-faint">empty</em>}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <fieldset>
        <legend className="label">Media — replaced by empty slots unless you package it (your media stays private by default)</legend>
        <ul className="space-y-1">
          {assetIds.map((id) => (
            <li key={id}>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={include.has(id)} onChange={(e) => setInclude((v) => { const n = new Set(v); if (e.target.checked) n.add(id); else n.delete(id); return n; })} />
                Package {id}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div className="flex gap-2">
        <button className="btn" onClick={() => call(true)}>Preview reuse</button>
        <button className="btn btn-primary" onClick={() => call(false)} disabled={!preview}>Save template</button>
      </div>
      {err && <p role="alert" className="text-bad">{err}</p>}
      {done && <p className="text-ok" role="status">{done}</p>}
      {preview && (
        <div className="rounded-md border border-line bg-bg p-2">
          <p className="mb-1 font-medium">Reuse preview (sample replacement: variables at defaults, media slots empty)</p>
          <p className="text-faint">Variables: {preview.variables.map((v) => `${v.label} (${v.kind})`).join(", ")}</p>
          <ol className="mt-1 list-decimal pl-4">
            {preview.preview.scenes.map((s, i) => (
              <li key={i}>{s.purpose}: {s.texts.filter(Boolean).join(" · ")}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

interface CreditItem { assetId: string; title?: string; source?: string; license?: string; licenseStatus?: string; attributionRequired: boolean; attribution: string | null; pageUrl?: string; licenseConfirmedByOwner: boolean }

/** Footage credits for this revision: what must be credited (CC BY / BY-SA) and a copyable credit block. */
/** OpenTimelineIO bundle (.otioz) of a rendered version, for finishing in Resolve, Premiere and other editors. */
function OtioExport({ projectId, revisionId, exports, jobs }: { projectId: string; revisionId: string; exports: ExportDTO[]; jobs: JobDTO[] }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const rendered = exports.some((e) => e.revisionId === revisionId);
  const job = jobs.find((j) => j.id === jobId) ?? jobs.find((j) => j.type === "export_otio");
  const active = job && ["queued", "running"].includes(job.status);
  const assetId = job?.status === "succeeded" && job.revisionId === revisionId ? String((job.result as { assetId?: string } | null)?.assetId ?? "") : "";
  useEffect(() => {
    setUrl(null);
    if (assetId) api<{ asset: { downloadUrl: string | null } }>(`/api/assets/${assetId}`).then((r) => setUrl(r.asset.downloadUrl)).catch(() => {});
  }, [assetId]);
  return (
    <section className="space-y-1.5 rounded-lg border border-line p-2.5 text-xs" aria-label="Export for editing">
      <div className="font-medium">Edit elsewhere (OpenTimelineIO)</div>
      <p className="text-faint">A .otioz bundle: the rendered program cut at every scene, plus voiceover, music and footage on their own tracks and music markers. Opens in DaVinci Resolve and other OTIO-aware editors with media linked.</p>
      <div className="flex items-center gap-2">
        <button
          className="btn px-3 text-xs"
          disabled={!rendered || !!active}
          title={rendered ? "" : "Render this version first"}
          onClick={async () => {
            setErr(null);
            try {
              const r = await api<{ job: JobDTO }>(`/api/projects/${projectId}/otio`, { method: "POST", idempotent: true, json: { revisionId } });
              setJobId(r.job.id);
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : String(e));
            }
          }}
        >
          {active ? `Packaging… ${job!.stage}` : "Package .otioz"}
        </button>
        {url && <a className="text-accent underline" href={url} download data-testid="otio-download">Download .otioz</a>}
      </div>
      {!rendered && <p className="text-faint">Render this version first — the timeline cuts the rendered program.</p>}
      {job?.status === "failed" && <p className="text-bad">{job.error?.message} {job.error?.recovery}</p>}
      {err && <p className="text-bad" role="alert">{err}</p>}
    </section>
  );
}

function Credits({ projectId, revisionId }: { projectId: string; revisionId: string }) {
  const [c, setC] = useState<{ items: CreditItem[]; attributionRequired: boolean; creditsText: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api<{ items: CreditItem[]; attributionRequired: boolean; creditsText: string }>(`/api/projects/${projectId}/credits`).then(setC).catch(() => {});
  }, [projectId, revisionId]);
  if (!c || c.items.length === 0) return null;
  return (
    <section className="rounded-md border border-line p-2 text-xs" aria-label="Footage credits">
      <p className="font-medium">Footage credits</p>
      {c.attributionRequired ? (
        <>
          <p className="text-warn">Some footage in this video must be credited (for example in the description or end card):</p>
          <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-bg p-2">{c.creditsText}</pre>
          <button
            type="button"
            className="btn mt-1 text-xs"
            onClick={() => {
              void navigator.clipboard?.writeText(c.creditsText).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy credits"}
          </button>
        </>
      ) : (
        <p className="text-dim">No credit is required for the sourced footage in this revision.</p>
      )}
      <ul className="mt-1 space-y-0.5 text-faint">
        {c.items.map((i) => (
          <li key={i.assetId}>
            {i.title} — {i.license}
            {i.licenseConfirmedByOwner ? " (no licence stated; confirmed by you)" : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
