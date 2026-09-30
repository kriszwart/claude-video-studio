"use client";
import { useEffect, useState } from "react";
import { api, ApiError, waitForJob } from "@/lib/client/api";

type Source = "internet_archive" | "wikimedia" | "pexels" | "pixabay";
type Kind = "video" | "image";
interface SourceInfo { id: Source; label: string; needsKey: boolean; available: boolean; setup: string | null }
interface License { status: string; name: string; url: string | null; attributionRequired: boolean; attribution: string | null }
interface Item { source: Source; id: string; kind: Kind; title: string; creator: string | null; pageUrl: string; thumbUrl: string | null; previewUrl: string | null; width?: number; height?: number; durationSec?: number; license: License }
interface Result { items: Item[]; total: number | null; page: number; nextPage: number | null }

const LICENSE_TONE: Record<string, string> = { public_domain: "text-ok", cc0: "text-ok", platform: "text-ok", attribution: "text-warn", unknown: "text-bad", restricted: "text-bad" };
const LICENSE_HELP: Record<string, string> = {
  public_domain: "Public domain: free to use.",
  cc0: "CC0: free to use, no attribution needed.",
  platform: "Free under the platform's licence; crediting is appreciated.",
  attribution: "Free to use with a credit line (listed under Export → Credits).",
  unknown: "The source states no licence — check the item page before using it.",
  restricted: "Non-commercial or no-derivatives: can't be imported for video edits.",
};
const fmt = (s?: number) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

/**
 * Search free footage/images (Internet Archive, Wikimedia Commons, Pexels, Pixabay) and import
 * items as assets with their licence recorded. Not a <form>: it is used inside other forms.
 */
export function FootageSearch({ kind: fixedKind, onImported }: { kind?: Kind; onImported?: (assetId: string) => void }) {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [source, setSource] = useState<Source>("internet_archive");
  const [kind, setKind] = useState<Kind>(fixedKind ?? "video");
  const [q, setQ] = useState("");
  const [openOnly, setOpenOnly] = useState(true);
  const [rights, setRights] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    api<{ sources: SourceInfo[] }>("/api/footage/sources").then((r) => setSources(r.sources)).catch(() => {});
  }, []);
  useEffect(() => setResult(null), [source, kind]);
  const current = sources.find((s) => s.id === source);

  const search = async (page = 1) => {
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<Result>(`/api/footage/search?source=${source}&kind=${kind}&page=${page}&openOnly=${openOnly ? 1 : 0}&q=${encodeURIComponent(q.trim())}`);
      setResult(page === 1 || !result ? r : { ...r, items: [...result.items, ...r.items] });
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.message}${e.recovery ? ` (${e.recovery})` : ""}` : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importItem = async (item: Item, confirmUnknown = false) => {
    const key = `${item.source}:${item.id}`;
    setConfirm(null);
    setState((s) => ({ ...s, [key]: "Importing…" }));
    try {
      const r = await api<{ job: { id: string } }>("/api/footage/import", { method: "POST", idempotent: true, json: { source: item.source, id: item.id, kind: item.kind, rightsAcknowledged: true, confirmUnknownLicense: confirmUnknown || undefined } });
      const done = await waitForJob(r.job.id, (j) => setState((s) => ({ ...s, [key]: j.stage })));
      if (done.status !== "succeeded") throw new Error(done.error?.message ?? "Import failed.");
      const assetId = String((done.result as { assetId?: string }).assetId ?? "");
      setState((s) => ({ ...s, [key]: "Imported ✓" }));
      if (assetId) onImported?.(assetId);
    } catch (e) {
      if (e instanceof ApiError && e.code === "license_unconfirmed") {
        setState((s) => ({ ...s, [key]: "" }));
        setConfirm(key);
        return;
      }
      setState((s) => ({ ...s, [key]: `✗ ${e instanceof ApiError || e instanceof Error ? e.message : String(e)}` }));
    }
  };

  return (
    <div className="space-y-2 text-xs" aria-label="Find footage">
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Footage source">
        {sources.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={source === s.id} className={`btn px-2 py-0.5 text-xs ${source === s.id ? "bg-panel-2" : "btn-ghost text-dim"}`} onClick={() => setSource(s.id)}>
            {s.label}
            {!s.available && <span className="ml-1 text-faint">(key needed)</span>}
          </button>
        ))}
      </div>
      {current && !current.available ? (
        <p className="text-dim">{current.setup} <a className="text-accent underline" href="/settings">Open Settings</a></p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {!fixedKind && (
              <select className="input w-auto py-1 text-xs" aria-label="Media type" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="video">Video</option>
                <option value="image">Images</option>
              </select>
            )}
            <input
              className="input min-w-40 flex-1 py-1 text-xs"
              type="search"
              aria-label="Search footage"
              placeholder={`Search ${current?.label ?? "footage"}… e.g. “harbour at dawn”`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void search();
                }
              }}
            />
            <button type="button" className="btn text-xs" disabled={busy || !q.trim()} onClick={() => search()}>
              {busy ? "Searching…" : "Search"}
            </button>
          </div>
          {(source === "internet_archive" || source === "wikimedia") && (
            <label className="flex items-center gap-1 text-dim">
              <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Only public domain and Creative Commons (CC0, BY, BY-SA)
            </label>
          )}
          <label className="flex items-center gap-1 text-dim">
            <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} /> I&apos;ll use imported items under their licence and credit them where required
          </label>
        </>
      )}
      {err && <p role="alert" className="text-bad">{err}</p>}
      {result && (
        <>
          <p className="text-faint">
            {result.items.length === 0 ? "No results." : `${result.total !== null ? `${result.total.toLocaleString()} results` : "Results"} from ${current?.label}. Each item shows the licence the source reports.`}
          </p>
          <ul className="grid max-h-96 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
            {result.items.map((i) => {
              const key = `${i.source}:${i.id}`;
              const st = state[key];
              return (
                <li key={key} className="rounded border border-line p-1">
                  <Thumb item={i} />
                  <p className="mt-1 line-clamp-2 font-medium" title={i.title}>{i.title}</p>
                  <p className="truncate text-faint">{[i.creator, fmt(i.durationSec), i.width && i.height ? `${i.width}×${i.height}` : null].filter(Boolean).join(" · ")}</p>
                  <p className={`${LICENSE_TONE[i.license.status] ?? ""}`} title={LICENSE_HELP[i.license.status]}>
                    {i.license.url ? <a className="underline" href={i.license.url} target="_blank" rel="noreferrer noopener">{i.license.name}</a> : i.license.name}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <a className="text-accent underline" href={i.pageUrl} target="_blank" rel="noreferrer noopener">Source page</a>
                    {confirm === key ? (
                      <span className="w-full space-y-1">
                        <span className="block text-warn">No licence stated. Only continue if you checked the source page and may use it.</span>
                        <button type="button" className="btn text-xs" onClick={() => importItem(i, true)}>I checked — import</button>
                        <button type="button" className="btn btn-ghost text-xs" onClick={() => setConfirm(null)}>Cancel</button>
                      </span>
                    ) : (
                      <button type="button" className="btn ml-auto px-2 py-0.5 text-xs" disabled={!rights || i.license.status === "restricted" || (!!st && st !== "" && !st.startsWith("✗"))} title={i.license.status === "restricted" ? LICENSE_HELP.restricted : !rights ? "Tick the licence checkbox first" : ""} onClick={() => importItem(i)}>
                        Import
                      </button>
                    )}
                  </div>
                  {st && <p role="status" className={st.startsWith("✗") ? "text-bad" : "text-dim"}>{st}</p>}
                </li>
              );
            })}
          </ul>
          {result.nextPage && (
            <button type="button" className="btn text-xs" disabled={busy} onClick={() => search(result.nextPage!)}>
              More results
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Thumb({ item }: { item: Item }) {
  const [hover, setHover] = useState(false);
  const box = "aspect-video w-full rounded bg-bg object-cover";
  if (item.kind === "video" && hover && item.previewUrl) {
    return <video className={box} src={item.previewUrl} muted autoPlay loop playsInline onMouseLeave={() => setHover(false)} />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return item.thumbUrl ? <img className={box} src={item.thumbUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onMouseEnter={() => setHover(true)} /> : <div className={`${box} flex items-center justify-center text-faint`} onMouseEnter={() => setHover(true)}>{item.kind}</div>;
}
