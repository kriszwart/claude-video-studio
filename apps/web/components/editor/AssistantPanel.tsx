"use client";
import Link from "next/link";
import { useState } from "react";
import type { ProjectDocument } from "@vs/domain";
import { api, ApiError } from "@/lib/client/api";
import type { JobDTO } from "./types";

const EXAMPLES = ["Slow down scene three by two seconds.", "Make the typography calmer and a little smaller.", "Make a portrait version and keep the existing wording.", "Use a fade into every scene."];

export function AssistantPanel({ projectId, doc, revisionId, selected, jobs, claudeConfigured }: { projectId: string; doc: ProjectDocument; revisionId: string; selected: string | null; jobs: JobDTO[]; claudeConfigured: boolean }) {
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

  if (!claudeConfigured) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-dim">The Creative Assistant needs a Claude API key on the server.</p>
        <Link href="/settings" className="btn">Set up Claude</Link>
        <p className="text-xs text-faint">Everything else — scene editing, uploads, rendering and exports — keeps working without it.</p>
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
        <textarea id="ask" className="input min-h-20" placeholder="Describe a change… e.g. “Replace that screenshot and tighten the headline.”" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim() && void send()} />
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
      <ol className="min-h-0 space-y-2 overflow-y-auto">
        {history.map((j) => (
          <li key={j.id} className="rounded-md border border-line bg-bg p-2 text-xs">
            <div className="mb-1 flex items-center gap-2 text-faint">
              <span>{j.type === "plan" ? "Storyboard plan" : "Assistant"}</span>
              <span>· {j.status === "running" || j.status === "queued" ? j.stage : j.status}</span>
            </div>
            <AssistantResult job={j} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function AssistantResult({ job }: { job: JobDTO }) {
  const r = job.result as Record<string, unknown> | null;
  if (job.status === "failed") return <p className="text-bad">{job.error?.message} {job.error?.recovery && <span className="text-dim">{job.error.recovery}</span>}</p>;
  if (!r) return <p className="text-dim">Waiting…</p>;
  const status = String(r.status ?? "");
  if (status === "clarify") return <p><span className="text-warn">Question:</span> {String(r.question)}</p>;
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
    <p>
      {String(r.explanation ?? "")}
      {r.rebased ? <span className="text-faint"> (rebased onto your newer edits)</span> : null}
      {status === "applied" && <span className="text-ok"> Applied — undo is available.</span>}
    </p>
  );
}
