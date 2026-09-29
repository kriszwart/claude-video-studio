"use client";
import { use, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";

interface Change {
  field: string;
  from: unknown;
  to: unknown;
  because?: string;
}
interface Version {
  version: number;
  data: Record<string, unknown>;
  changeSummary: Change[];
  createdAt: string;
  evidence: { traits?: { field: string; basis: string; detail: string }[] };
}
interface View {
  profile: { id: string; name: string; latestVersion: number };
  versions: Version[];
}
interface Proposal {
  baseVersion: number;
  changes: Change[];
  unmatched: string[];
  proposed: Record<string, unknown>;
}

const show = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join("; ") : "—") : v === null || v === undefined ? "—" : String(v));

export default function ProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [v, setV] = useState<View | null>(null);
  const [feedback, setFeedback] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [projects, setProjects] = useState<{ id: string; title: string }[]>([]);
  const [target, setTarget] = useState("");
  const [applyVersion, setApplyVersion] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await api<View>(`/api/profiles/${id}`);
    setV(r);
    setApplyVersion((x) => x || r.profile.latestVersion);
  }, [id]);
  useEffect(() => {
    void load();
    void api<{ projects: { id: string; title: string }[] }>("/api/projects").then((r) => setProjects(r.projects));
  }, [load]);
  if (!v) return <main className="p-6 text-dim">Loading…</main>;
  const latest = v.versions.at(-1)!;
  const fail = (x: unknown) => setErr(x instanceof ApiError ? x.message : String(x));

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="text-xl font-semibold">{v.profile.name} <span className="text-sm font-normal text-faint">v{v.profile.latestVersion}</span></h1>
      <p className="mb-4 text-xs text-faint">
        <a className="underline" href={`/api/profiles/${id}/versions/${latest.version}/markdown`}>Export v{latest.version} as Markdown</a> (a description of the style for documentation; it is not executed).
      </p>
      {err && <p role="alert" className="mb-3 text-sm text-red-400">{err}</p>}
      {msg && <p role="status" className="mb-3 text-sm text-emerald-400">{msg}</p>}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-4" aria-labelledby="cur-h">
          <h2 id="cur-h" className="mb-2 font-medium">Current settings (v{latest.version})</h2>
          <dl className="grid grid-cols-[140px_1fr] gap-y-1 text-sm">
            {Object.entries(latest.data).map(([k, val]) => (
              <div key={k} className="contents"><dt className="text-faint">{k}</dt><dd>{show(val)}</dd></div>
            ))}
          </dl>
          <h3 className="mb-1 mt-4 text-sm font-medium">Version history</h3>
          <ol className="space-y-2 text-xs" aria-label="Version history">
            {[...v.versions].reverse().map((ver) => (
              <li key={ver.version} className="rounded border border-line p-2" data-testid="profile-version">
                <p className="font-medium">v{ver.version} · {new Date(ver.createdAt).toLocaleString()}</p>
                {ver.changeSummary.length === 0 ? (
                  <p className="text-faint">{ver.evidence.traits?.length ? `Created from a reference (${ver.evidence.traits.filter((t) => t.basis === "measured").length} measured traits).` : "Created."}</p>
                ) : (
                  <ul>
                    {ver.changeSummary.map((c) => <li key={c.field}><strong>{c.field}</strong>: {show(c.from)} → {show(c.to)}{c.because ? <span className="text-faint"> (“{c.because}”)</span> : null}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section className="space-y-4">
          <div className="card p-4" aria-labelledby="fb-h">
            <h2 id="fb-h" className="mb-2 font-medium">Improve from feedback</h2>
            <p className="mb-2 text-xs text-faint">Describe what to change. You'll see the exact proposed changes before anything is saved; phrases that don't map to a setting are listed, not guessed.</p>
            <textarea className="input mb-2" rows={3} aria-label="Feedback" value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="e.g. larger text, fewer whooshes, longer explanation shots" />
            <button className="btn" disabled={!feedback.trim()} onClick={async () => { setErr(null); setMsg(null); try { setProposal(await api<Proposal>(`/api/profiles/${id}/propose`, { method: "POST", json: { feedback, baseVersion: latest.version } })); } catch (x) { fail(x); } }}>Propose changes</button>
            {proposal && (
              <div className="mt-3 rounded border border-line p-2 text-sm" role="region" aria-label="Proposed changes">
                {proposal.changes.length === 0 ? <p className="text-dim">No settings would change.</p> : (
                  <ul className="mb-2">
                    {proposal.changes.map((c) => <li key={c.field} data-testid="proposed-change"><strong>{c.field}</strong>: {show(c.from)} → {show(c.to)} <span className="text-xs text-faint">(“{c.because}”)</span></li>)}
                  </ul>
                )}
                {proposal.unmatched.length > 0 && <p className="mb-2 text-xs text-amber-400">Not understood (no change made): {proposal.unmatched.map((u) => `“${u}”`).join(", ")}</p>}
                <button className="btn btn-primary mr-2" disabled={!proposal.changes.length} onClick={async () => { setErr(null); try { await api(`/api/profiles/${id}`, { method: "POST", json: { baseVersion: proposal.baseVersion, data: proposal.proposed, reasons: proposal.changes.map((c) => ({ field: c.field, because: c.because })) } }); setProposal(null); setFeedback(""); setMsg(`Saved as v${proposal.baseVersion + 1}. Projects using earlier versions are unchanged.`); await load(); } catch (x) { fail(x); } }}>Save as v{proposal.baseVersion + 1}</button>
                <button className="btn btn-ghost" onClick={() => setProposal(null)}>Discard</button>
              </div>
            )}
          </div>

          <div className="card p-4" aria-labelledby="apply-h">
            <h2 id="apply-h" className="mb-2 font-medium">Apply to a project</h2>
            <div className="flex flex-wrap gap-2">
              <select className="input w-auto" aria-label="Project" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Choose a project…</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
              <select className="input w-auto" aria-label="Version" value={applyVersion} onChange={(e) => setApplyVersion(Number(e.target.value))}>
                {v.versions.map((ver) => <option key={ver.version} value={ver.version}>v{ver.version}</option>)}
              </select>
              <button className="btn btn-primary" disabled={!target} onClick={async () => { setErr(null); setMsg(null); try { const pv = await api<{ revision: { id: string } }>(`/api/projects/${target}`); await api(`/api/projects/${target}/profile`, { method: "POST", json: { baseRevisionId: pv.revision.id, profileId: id, version: applyVersion } }); setMsg(`Applied v${applyVersion} (undoable in the project).`); } catch (x) { fail(x); } }}>Apply</button>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
