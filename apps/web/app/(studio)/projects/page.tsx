"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useClaudeStatus } from "@/lib/client/claude";
import { api, ApiError, waitForJob } from "@/lib/client/api";

interface ProjectItem {
  id: string;
  title: string;
  family: string;
  isSample: boolean;
  updatedAt: string;
  variantLabel: string | null;
  thumbnailAssetId: string | null;
  posterUrl: string | null;
  rendered: boolean;
}

const FAMILY_LABEL: Record<string, string> = {
  "product-launch": "Product launch",
  "motion-reel": "Motion reel",
  "vertical-short": "Vertical short",
  "talking-head": "Talking head",
  "mascot-story": "Mascot story",
  "music-video": "Music video",
  "anime-opening": "Anime opening",
};
const familyLabel = (f: string) => FAMILY_LABEL[f] ?? f.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function Projects() {
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [projects, setProjects] = useState<ProjectItem[] | null>(null);
  const [claudeStatus] = useClaudeStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ projects: ProjectItem[] }>(`/api/projects?status=${tab}`);
    setProjects(r.projects);
  }, [tab]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setErr(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const claudeReady = !!claudeStatus?.readiness.available;

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Projects</h1>
        <div role="tablist" className="ml-2 flex gap-1">
          {(["active", "archived"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`btn btn-ghost text-xs ${tab === t ? "bg-panel-2" : "text-dim"}`} onClick={() => setTab(t)}>
              {t === "active" ? "Active" : "Archived"}
            </button>
          ))}
        </div>
        <Link href="/projects/new" className="btn btn-primary ml-auto">
          New project
        </Link>
      </div>

      {projects && projects.length === 0 && tab === "active" && (
        <section className="card mb-6 p-5">
          <h2 className="mb-1 font-semibold">Get started</h2>
          <p className="mb-4 text-sm text-dim">A short setup checklist. Everything except AI planning works without Claude; AI uses your Claude plan through Claude Code — no API key needed.</p>
          <ol className="mb-4 space-y-2 text-sm">
            <li>
              {claudeReady ? "✓" : "○"} Claude for storyboard planning and the Creative Assistant (sign in to Claude Code with your plan) —{" "}
              <Link className="text-accent underline" href="/settings#claude">{claudeReady ? "ready" : claudeStatus ? "set up" : "checking…"}</Link>
            </li>
            <li>○ Create a brand kit with your colours, fonts and logo — <Link className="text-accent underline" href="/brand-kits">Brand Kits</Link></li>
            <li>○ Upload screenshots, logos and music — <Link className="text-accent underline" href="/assets">Assets</Link></li>
          </ol>
          <button
            className="btn"
            disabled={!!busy}
            onClick={() =>
              act("sample", async () => {
                const { job } = await api<{ job: { id: string } }>("/api/sample", { method: "POST" });
                const done = await waitForJob(job.id);
                if (done.status !== "succeeded") throw new Error(done.error?.message ?? "Could not create the sample");
                location.href = `/projects/${done.result?.projectId}`;
              })
            }
          >
            {busy === "sample" ? "Creating sample…" : "Open the sample product-launch project"}
          </button>
          <span className="ml-3 text-xs text-faint">Sample data: a fictional product with generated assets.</span>
        </section>
      )}
      {err && <p role="alert" className="mb-4 text-sm text-bad">{err}</p>}
      {!projects ? (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading projects">
          {[0, 1, 2].map((i) => (
            <li key={i} className="card overflow-hidden">
              <div className="aspect-video animate-pulse bg-panel-2" />
              <div className="space-y-2 p-3"><div className="h-3 w-1/2 rounded bg-panel-2" /><div className="h-2.5 w-1/3 rounded bg-panel-2" /></div>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <li key={p.id} className="card group overflow-hidden transition-colors hover:border-accent/50">
              <Link href={`/projects/${p.id}`} className="block">
                <div className="relative aspect-video overflow-hidden bg-bg">
                  {p.posterUrl ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.posterUrl} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-xl" />
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.posterUrl} alt={`Preview of ${p.title}`} className="relative h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.02]" />
                    </>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-1 bg-[radial-gradient(circle_at_30%_20%,color-mix(in_srgb,var(--color-accent)_22%,transparent),transparent_65%)]">
                      <span className="text-sm font-semibold text-white/70">{familyLabel(p.family)}</span>
                      <span className="text-[11px] text-faint">Open to generate a preview</span>
                    </div>
                  )}
                  <span className={`absolute right-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-medium ${p.rendered ? "bg-black/70 text-white" : "bg-black/60 text-dim"}`}>{p.rendered ? "Rendered" : "Draft"}</span>
                </div>
                <div className="px-3 pb-2 pt-3">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{p.title}</span>
                    {p.isSample && <span className="sample-badge">Sample</span>}
                  </div>
                  <div className="mt-1 text-xs text-faint">
                    {familyLabel(p.family)}
                    {p.variantLabel ? ` · ${p.variantLabel}` : ""} · <span title={new Date(p.updatedAt).toLocaleString()}>edited {ago(p.updatedAt)}</span>
                  </div>
                </div>
              </Link>
              <div className="flex gap-1 px-2 pb-2 opacity-80 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <button className="btn btn-ghost px-2 py-1 text-xs" disabled={!!busy} onClick={() => act("dup", () => api(`/api/projects/${p.id}/duplicate`, { method: "POST" }))}>Duplicate</button>
                <button className="btn btn-ghost px-2 py-1 text-xs" disabled={!!busy} onClick={() => act("arch", () => api(`/api/projects/${p.id}`, { method: "PATCH", json: { status: tab === "active" ? "archived" : "active" } }))}>
                  {tab === "active" ? "Archive" : "Restore"}
                </button>
                <button
                  className="btn btn-ghost ml-auto px-2 py-1 text-xs text-bad"
                  disabled={!!busy}
                  onClick={() => {
                    if (confirm(`Delete "${p.title}"? Running jobs are cancelled. Renders are purged after a 7-day recovery period; uploaded media stays in your library.`)) void act("del", () => api(`/api/projects/${p.id}`, { method: "DELETE" }));
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
