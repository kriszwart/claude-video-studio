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
        <p className="text-dim">Loading…</p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <li key={p.id} className="card overflow-hidden">
              <Link href={`/projects/${p.id}`} className="block">
                <div className="flex aspect-video items-center justify-center bg-bg text-xs text-faint">
                  {p.thumbnailAssetId ? <ProjectThumb projectId={p.id} /> : "No render yet"}
                </div>
                <div className="p-3">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{p.title}</span>
                    {p.isSample && <span className="sample-badge">Sample</span>}
                  </div>
                  <div className="mt-1 text-xs text-faint">
                    {p.family}
                    {p.variantLabel ? ` · ${p.variantLabel}` : ""} · edited {new Date(p.updatedAt).toLocaleString()}
                  </div>
                </div>
              </Link>
              <div className="flex gap-1 border-t border-line p-2">
                <button className="btn btn-ghost text-xs" disabled={!!busy} onClick={() => act("dup", () => api(`/api/projects/${p.id}/duplicate`, { method: "POST" }))}>Duplicate</button>
                <button className="btn btn-ghost text-xs" disabled={!!busy} onClick={() => act("arch", () => api(`/api/projects/${p.id}`, { method: "PATCH", json: { status: tab === "active" ? "archived" : "active" } }))}>
                  {tab === "active" ? "Archive" : "Restore"}
                </button>
                <button
                  className="btn btn-ghost ml-auto text-xs text-bad"
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

function ProjectThumb({ projectId }: { projectId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    api<{ exports: { thumbUrl: string | null }[] }>(`/api/projects/${projectId}/exports`).then((r) => setUrl(r.exports[0]?.thumbUrl ?? null)).catch(() => {});
  }, [projectId]);
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="" className="h-full w-full object-cover" /> : null;
}
