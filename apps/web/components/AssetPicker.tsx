"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, uploadFile, waitForJob, type UploadedAsset } from "@/lib/client/api";

const ACCEPT: Record<string, string> = {
  image: "image/png,image/jpeg,image/webp,image/gif,image/svg+xml",
  video: "video/mp4,video/quicktime,video/webm",
  audio: "audio/*",
  font: ".ttf,.otf,.woff,.woff2",
  document: ".srt,.vtt,application/x-subrip,text/vtt",
};

/** Pick assets from the workspace library or upload new ones (with a rights acknowledgement). */
export function AssetPicker({
  kind,
  multiple = false,
  value,
  onChange,
  max = 8,
}: {
  kind: "image" | "video" | "audio" | "font" | "document";
  multiple?: boolean;
  value: string[];
  onChange: (ids: string[]) => void;
  max?: number;
}) {
  const [assets, setAssets] = useState<UploadedAsset[]>([]);
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rights, setRights] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  const load = useCallback(async () => {
    const kinds = kind === "image" ? ["image", "svg"] : [kind];
    const all: UploadedAsset[] = [];
    for (const k of kinds) all.push(...(await api<{ assets: UploadedAsset[] }>(`/api/assets?kind=${k}`)).assets);
    // Selected assets always show, even when older than the listing page.
    for (const id of valueRef.current.filter((x) => !all.some((a) => a.id === x))) {
      const r = await api<{ asset: UploadedAsset }>(`/api/assets/${id}`).catch(() => null);
      if (r) all.push(r.asset);
    }
    setAssets(all.filter((a) => a.status === "ready"));
  }, [kind]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (value.some((id) => !assets.some((a) => a.id === id))) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.join(",")]);
  const importLink = async () => {
    const url = linkUrl.trim();
    if (!url || !rights || progress) return;
    setErr(null);
    setProgress("Importing link…");
    try {
      const r = await api<{ job: { id: string } }>("/api/assets/import", { method: "POST", json: { url, rightsAcknowledged: true } });
      const done = await waitForJob(r.job.id, (j) => setProgress(`Importing link: ${j.stage}`));
      if (done.status !== "succeeded") throw new Error(done.error?.message ?? "Import failed.");
      await load();
      setLinkUrl("");
      const id = String((done.result as { assetId?: string }).assetId ?? "");
      if (id) onChange(multiple ? [...value, id].slice(0, max) : [id]);
    } catch (x) {
      setErr(x instanceof ApiError || x instanceof Error ? x.message : String(x));
    } finally {
      setProgress(null);
    }
  };
  const selected = value.map((id) => assets.find((a) => a.id === id)).filter(Boolean) as UploadedAsset[];
  const toggle = (id: string) => {
    if (!multiple) return onChange(value[0] === id ? [] : [id]);
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id].slice(0, max));
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {selected.map((a) => (
          <span key={a.id} className="chip">
            {a.thumbUrl && kind !== "audio" ? <img src={a.thumbUrl} alt="" className="h-5 w-8 rounded object-cover" /> : null}
            <span className="max-w-40 truncate">{a.name}</span>
            {a.isSample && <span className="sample-badge">Sample</span>}
            <button type="button" aria-label={`Remove ${a.name}`} className="text-faint hover:text-ink" onClick={() => toggle(a.id)}>
              ×
            </button>
          </span>
        ))}
        <button type="button" className="btn text-xs" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Close library" : selected.length ? "Change…" : `Choose ${kind === "document" ? "subtitle file" : kind}${multiple ? "s" : ""}…`}
        </button>
      </div>
      {open && (
        <div className="mt-2 rounded-md border border-line bg-bg p-2">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-dim">
              <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} />I have the rights to use uploaded files
            </label>
            <button type="button" className="btn text-xs" disabled={!rights || !!progress} onClick={() => input.current?.click()}>
              Upload…
            </button>
            <input
              ref={input}
              type="file"
              hidden
              multiple={multiple}
              accept={ACCEPT[kind]}
              onChange={async (e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                setErr(null);
                const ids: string[] = [];
                for (const f of files) {
                  try {
                    const a = await uploadFile(f, { rightsAcknowledged: rights, onProgress: (p, stage) => setProgress(`${f.name}: ${stage === "uploading" ? `${Math.round(p * 100)}%` : stage}`) });
                    ids.push(a.id);
                  } catch (x) {
                    setErr(x instanceof ApiError ? `${f.name}: ${x.message}` : String(x));
                  }
                }
                setProgress(null);
                await load();
                if (ids.length) onChange(multiple ? [...value, ...ids].slice(0, max) : [ids[0]!]);
              }}
            />
            {progress && <span className="text-xs text-dim" aria-live="polite">{progress}</span>}
          </div>
          {kind !== "font" && kind !== "document" && (
            // Not a <form>: the picker is used inside other forms (e.g. New Project), and a nested
            // form is invalid HTML — the browser drops it and Import would submit the outer form.
            <div className="mb-2 flex gap-2" role="group" aria-label="Import from link">
              <input
                type="url"
                className="input py-1 text-xs"
                placeholder="https://… (public link)"
                aria-label="Import from link"
                disabled={!rights || !!progress}
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void importLink();
                  }
                }}
              />
              <button type="button" className="btn text-xs" disabled={!rights || !!progress || !linkUrl.trim()} onClick={() => void importLink()}>
                Import
              </button>
            </div>
          )}
          {err && <p role="alert" className="mb-2 text-xs text-bad">{err}</p>}
          {assets.length === 0 ? (
            <p className="text-xs text-faint">No {kind} assets yet.</p>
          ) : (
            <ul className="grid max-h-64 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
              {assets.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => toggle(a.id)} aria-pressed={value.includes(a.id)} className={`w-full rounded border p-1 text-left ${value.includes(a.id) ? "border-accent" : "border-line"}`}>
                    <div className="flex aspect-video items-center justify-center overflow-hidden rounded bg-panel text-[10px] text-faint">
                      {a.thumbUrl && kind !== "audio" ? <img src={a.thumbUrl} alt="" className="h-full w-full object-contain" /> : kind === "audio" ? `♪ ${Number(a.media.durationSec ?? 0).toFixed(1)}s` : kind}
                    </div>
                    <div className="mt-1 truncate text-[11px]">{a.name}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
