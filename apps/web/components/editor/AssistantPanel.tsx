"use client";
import Link from "next/link";
import { useState } from "react";
import type { ProjectDocument } from "@vs/domain";
import { api, ApiError } from "@/lib/client/api";
import type { ClaudeStatus } from "@/lib/client/claude";
import type { JobDTO } from "./types";

const EXAMPLES = ["Slow down scene three by two seconds.", "Make the typography calmer and a little smaller.", "Make a portrait version and keep the existing wording.", "Use a fade into every scene."];

export function AssistantPanel({ projectId, doc, revisionId, selected, jobs, claude }: { projectId: string; doc: ProjectDocument; revisionId: string; selected: string | null; jobs: JobDTO[]; claude: ClaudeStatus["readiness"] | null }) {
  const [text, setText] = useState("");
  const [scope, setScope] = useState<"selected" | "project">("selected");
  const [err, setErr] = useState<string | null>(null);
  const history = jobs.filter((j) => j.type === "assistant" || j.type === "plan").slice(0, 12);
  const running = history.find((j) => ["queued", "running"].includes(j.status));

  const send = async () => {
    setErr(null);
    try {
      await api(`/api/projects/${projectId}/assistant`, { method: "POST", idempotent: true, json: { baseRevisionId: revisionId, request: text, selectedSceneIds: scope === "selected" && selected ? [selected] : [] } });
      setText("");
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.message}${e.recovery ? ` ${e.recovery}` : ""}` : String(e));
    }
  };
  const replan = async () => {
    setErr(null);
    try {
      await api(`/api/projects/${projectId}/plan`, { method: "POST", idempotent: true, json: { baseRevisionId: revisionId } });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  if (!claude) return <p className="text-sm text-dim">Checking Claude…</p>;
  if (!claude.available) {
    return (
      <div className="space-y-3 text-sm">
        <div>
          <p className="font-medium">Integrated assistant: blocked</p>
          <p className="text-dim">{claude.message}</p>
          {claude.recovery && <p className="text-xs text-faint">{claude.recovery}</p>}
        </div>
        <Link href={claude.setupUrl} className="btn">Set up Claude</Link>
        <p className="text-xs text-faint">Everything else — scene editing, uploads, rendering and exports — keeps working without it.</p>
        <Handoff projectId={projectId} revisionId={revisionId} />
        <History jobs={history} />
      </div>
    );
  }
  const sel = doc.scenes.find((s) => s.id === selected);
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div>
        <div className="mb-2 flex gap-1 text-xs" role="radiogroup" aria-label="Assistant scope">
          <button role="radio" aria-checked={scope === "selected"} className={`btn btn-ghost px-2 py-0.5 text-xs ${scope === "selected" ? "bg-panel-2" : "text-dim"}`} onClick={() => setScope("selected")} disabled={!sel}>
            {sel ? `Scene ${doc.scenes.indexOf(sel) + 1} only` : "Selected scene"}
          </button>
          <button role="radio" aria-checked={scope === "project"} className={`btn btn-ghost px-2 py-0.5 text-xs ${scope === "project" ? "bg-panel-2" : "text-dim"}`} onClick={() => setScope("project")}>
            Whole project
          </button>
        </div>
        <label htmlFor="ask" className="sr-only">Ask the assistant</label>
        <textarea id="ask" className="input min-h-20" placeholder="Give notes like you would to an editor: what's wrong and what you want it to feel like. One per line, e.g. “The reminders card looks empty at 9.5 s: it should read as busy from its first frame.”" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim() && void send()} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" disabled={!text.trim() || !!running} onClick={send}>
            {running ? "Working…" : "Apply change"}
          </button>
          <button className="btn text-xs" disabled={!!running} onClick={replan} title="Re-plan the whole storyboard from the brief. Locked scenes are kept.">
            Re-plan storyboard
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {EXAMPLES.map((x) => (
            <button key={x} className="chip hover:text-ink" onClick={() => setText(x)}>{x}</button>
          ))}
        </div>
        {err && <p role="alert" className="mt-2 text-xs text-bad">{err}</p>}
      </div>
      <p className="text-xs text-faint">{claude.mode === "api" ? "Using the Claude API key (billed separately)." : "Using your Claude plan through Claude Code (counts toward your plan's usage limits)."}</p>
      <History jobs={history} />
      <Handoff projectId={projectId} revisionId={revisionId} />
    </div>
  );
}

function History({ jobs }: { jobs: JobDTO[] }) {
  if (!jobs.length) return null;
  return (
    <ol className="min-h-0 space-y-2 overflow-y-auto">
      {jobs.map((j) => (
        <li key={j.id} className="rounded-md border border-line bg-bg p-2 text-xs">
          <div className="mb-1 flex items-center gap-2 text-faint">
            <span>{j.type === "plan" ? "Storyboard plan" : "Assistant"}</span>
            <span>· {j.status === "running" || j.status === "queued" ? j.stage : j.status}</span>
          </div>
          <AssistantResult job={j} />
        </li>
      ))}
    </ol>
  );
}

/** Claude Code project-file handoff: export a snapshot, edit with Claude Code in a terminal, import typed operations. */
function Handoff({ projectId, revisionId }: { projectId: string; revisionId: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setMsg(null);
    try {
      const parsed = JSON.parse(await f.text()) as { baseRevisionId?: string; ops?: unknown[] };
      const r = await api<{ changedSceneIds: string[]; noop: boolean }>(`/api/projects/${projectId}/handoff`, { method: "POST", json: { baseRevisionId: parsed.baseRevisionId, ops: parsed.ops } });
      setMsg(r.noop ? "Imported: nothing changed." : `Imported and applied (${r.changedSceneIds.length} scene${r.changedSceneIds.length === 1 ? "" : "s"} changed). Undo is available.`);
    } catch (e) {
      setMsg(e instanceof ApiError ? `Not applied: ${e.message}${e.recovery ? ` ${e.recovery}` : ""}` : e instanceof SyntaxError ? "Not applied: the file is not valid JSON." : String(e));
    }
  };
  return (
    <details className="rounded-md border border-line p-2 text-xs">
      <summary className="cursor-pointer text-dim">Claude Code handoff (edit in your terminal)</summary>
      <p className="mt-2 text-faint">Download this revision, ask Claude Code for a change in its folder, then import the <code>operations.json</code> it writes. Imports are checked like assistant edits (locks, approved claims, creative mode, base revision).</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <a className="btn text-xs" href={`/api/projects/${projectId}/handoff`} download>Download project file</a>
        <label className="btn text-xs">
          Import operations file
          <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        <span className="text-faint">Current revision: <code>{revisionId}</code></span>
      </div>
      {msg && <p role="status" className="mt-2">{msg}</p>}
    </details>
  );
}

function AssistantResult({ job }: { job: JobDTO }) {
  const r = job.result as Record<string, unknown> | null;
  if (job.status === "failed") return <p className="text-bad">{job.error?.message} {job.error?.recovery && <span className="text-dim">{job.error.recovery}</span>}</p>;
  if (job.status === "paused") return <PausedJob job={job} />;
  if (!r) return <p className="text-dim">Waiting…</p>;
  const status = String(r.status ?? "");
  if (status === "clarify")
    return (
      <div className="space-y-1">
        <p className={r.revisionId ? "" : "text-dim"}>{r.revisionId ? `Done so far: ${String(r.explanation ?? "")}` : String(r.explanation ?? "Nothing has been changed yet.")}</p>
        <p><span className="text-warn">Question:</span> {String(r.question)}</p>
        <NotesRead r={r} />
      </div>
    );
  if (status === "rejected_stale" || status === "stale" || status === "refused") return <p className="text-warn">{String(r.message)}</p>;
  if (job.type === "plan") {
    return (
      <div className="space-y-1">
        <p>{String(r.rationale ?? "")}</p>
        {Array.isArray(r.omitted) && r.omitted.length > 0 && <p className="text-dim">Omitted: {(r.omitted as { recipeSlot: string; reason: string }[]).map((o) => `${o.recipeSlot} (${o.reason})`).join("; ")}</p>}
        {Array.isArray(r.warnings) && r.warnings.length > 0 && <p className="text-warn">{(r.warnings as string[]).join(" ")}</p>}
        {Number(r.attempts) > 1 && <p className="text-faint">Needed {String(r.attempts)} attempts to pass validation.</p>}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <p>
        {String(r.explanation ?? "")}
        {r.rebased ? <span className="text-faint"> (rebased onto your newer edits)</span> : null}
        {status === "applied" && <span className="text-ok"> Applied — undo is available.</span>}
      </p>
      <NotesRead r={r} />
    </div>
  );
}

/** How the assistant read each note (problem → result), whether it got there, and what it would still change. */
function NotesRead({ r }: { r: Record<string, unknown> }) {
  const notes = (Array.isArray(r.notes) ? r.notes : []) as { note: string; problem: string; result: string; done: boolean; how: string }[];
  const still = (Array.isArray(r.stillChange) ? r.stillChange : []) as string[];
  if (!notes.length && !still.length) return null;
  return (
    <div className="space-y-1.5" data-testid="notes-read">
      {notes.length > 0 && (
        <ol className="space-y-1">
          {notes.map((n, i) => (
            <li key={i} className="rounded border border-line p-1.5" data-done={n.done}>
              <div className="flex items-start gap-1.5">
                <span className={n.done ? "text-ok" : "text-warn"} aria-label={n.done ? "Done" : "Not fully done"}>
                  {n.done ? "✓" : "◐"}
                </span>
                <span>
                  <span className="text-dim">{n.problem}</span> → <span className="font-medium">{n.result}</span>
                </span>
              </div>
              <p className="pl-4 text-faint">{n.how}</p>
            </li>
          ))}
        </ol>
      )}
      {still.length > 0 && (
        <div data-testid="assistant-still-change">
          <p className="text-dim">What I&apos;d still change:</p>
          <ul className="list-disc pl-4">
            {still.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A job paused at a plan usage limit: the owner resumes it explicitly (never an automatic paid fallback). */
function PausedJob({ job }: { job: JobDTO }) {
  const [err, setErr] = useState<string | null>(null);
  const act = (path: string) => api(`/api/jobs/${job.id}/${path}`, { method: "POST" }).catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  return (
    <div className="space-y-1">
      <p className="text-warn">{job.error?.message}</p>
      {job.error?.recovery && <p className="text-dim">{job.error.recovery}</p>}
      <div className="flex gap-2">
        <button className="btn text-xs" onClick={() => act("retry")}>Resume</button>
        <button className="btn btn-ghost text-xs" onClick={() => act("cancel")}>Cancel</button>
      </div>
      {err && <p className="text-bad">{err}</p>}
    </div>
  );
}
