"use client";
import { useMemo, useState } from "react";
import { lintScript, SCRIPT_STYLE_IDS, SCRIPT_STYLES, wordBudget, wordCount, type Operation, type ProjectDocument, type ScriptStyle } from "@vs/domain";
import { api, ApiError } from "@/lib/client/api";
import { DebouncedText, NumberField } from "./fields";
import type { JobDTO } from "./types";

/**
 * Script stage: review and edit the narration and on-screen line per beat, rewrite with a note,
 * then approve — approval starts storyboard planning, which keeps the narration verbatim.
 */
export function ScriptPanel({
  projectId,
  doc,
  jobs,
  apply,
  revRef,
  claudeReady,
}: {
  projectId: string;
  doc: ProjectDocument;
  jobs: JobDTO[];
  apply: (ops: Operation[]) => Promise<boolean>;
  revRef: { current: string | null };
  claudeReady: boolean;
}) {
  const script = doc.script;
  const writing = jobs.find((j) => j.type === "write_script" && ["queued", "running"].includes(j.status));
  const failed = jobs.find((j) => j.type === "write_script" && ["failed", "paused"].includes(j.status));
  const lastWrite = jobs.find((j) => j.type === "write_script");
  const planning = jobs.find((j) => j.type === "plan" && ["queued", "running"].includes(j.status));
  const [style, setStyle] = useState<ScriptStyle>(script?.style ?? "professor");
  const [direction, setDirection] = useState(script?.direction ?? "");
  const [narrated, setNarrated] = useState(script?.narrated ?? true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const issues = useMemo(() => (script ? lintScript(script) : []), [script]);
  const total = script?.beats.reduce((a, b) => a + b.durationSec, 0) ?? 0;
  const words = script?.beats.reduce((a, b) => a + wordCount(b.narration), 0) ?? 0;

  const write = async (withNote: boolean) => {
    setErr(null);
    setBusy("write");
    try {
      await api(`/api/projects/${projectId}/script`, {
        method: "POST",
        idempotent: true,
        json: { style, direction, narrated, ...(withNote && note.trim() ? { note: note.trim() } : {}), ...(!script ? { targetDurationSec: Math.round(doc.scenes.reduce((a, s) => a + s.durationFrames, 0) / doc.format.fps) } : {}) },
      });
      setNote("");
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.message}${e.recovery ? ` — ${e.recovery}` : ""}` : String(e));
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!script) return;
    setErr(null);
    setBusy("approve");
    try {
      if (!(await apply([{ op: "setScriptStatus", status: "approved" }]))) throw new Error("Could not save the approval.");
      await api(`/api/projects/${projectId}/plan`, {
        method: "POST",
        idempotent: true,
        json: { baseRevisionId: revRef.current, ...(script.next.planEffort ? { effort: script.next.planEffort } : {}), ...(script.narrated && script.next.voiceId ? { narration: { voiceId: script.next.voiceId } } : {}) },
      });
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.message}${e.recovery ? ` — ${e.recovery}` : ""}` : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const setup = (
    <div className="space-y-3">
      <div>
        <label className="label" htmlFor="script-style">Writing style</label>
        <select id="script-style" className="input" value={style} onChange={(e) => setStyle(e.target.value as ScriptStyle)}>
          {SCRIPT_STYLE_IDS.map((id) => <option key={id} value={id}>{SCRIPT_STYLES[id].label} · {SCRIPT_STYLES[id].wpm} wpm</option>)}
        </select>
        <p className="mt-1 text-[11px] text-faint">{SCRIPT_STYLES[style].guide}</p>
      </div>
      <div>
        <label className="label" htmlFor="script-direction">Direction (optional)</label>
        <input id="script-direction" className="input" maxLength={400} placeholder="e.g. for first-year students; assume no prior knowledge" value={direction} onChange={(e) => setDirection(e.target.value)} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={narrated} onChange={(e) => setNarrated(e.target.checked)} /> Spoken voiceover
      </label>
    </div>
  );

  if (!script) {
    return (
      <section aria-label="Script" className="space-y-4">
        <div>
          <h2 className="panel-title">Script</h2>
          <p className="mt-1 text-sm text-dim">Have Claude write the narration and on-screen lines first. You edit and approve the exact words; the storyboard is then planned around them.</p>
        </div>
        {writing ? (
          <WritingStatus stage={writing.stage} />
        ) : (
          <>
            {setup}
            <button className="btn btn-primary w-full" disabled={!claudeReady || !!busy} onClick={() => void write(false)}>{busy ? "Starting…" : "Write the script"}</button>
            {!claudeReady && <p className="text-xs text-warn">Claude is not available. Set it up in Settings → Claude.</p>}
          </>
        )}
        {failed && !writing && <p className="text-xs text-bad" role="alert">Last attempt: {failed.error?.message} {failed.error?.recovery}</p>}
        {err && <p className="text-xs text-bad" role="alert">{err}</p>}
      </section>
    );
  }

  const approved = script.status === "approved";
  return (
    <section aria-label="Script" className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="panel-title">Script</h2>
        <span className={`chip ${approved ? "border-ok/40 text-ok" : "border-warn/40 text-warn"}`} data-testid="script-status">{approved ? "Approved" : "Draft — review and approve"}</span>
      </div>
      <p className="text-xs text-dim">
        {SCRIPT_STYLES[script.style].label}
        {script.direction ? ` · ${script.direction}` : ""} · {script.narrated ? `${words} words · ${Math.round(total)}s (fits ~${wordBudget(script.style, total)} words)` : `no voiceover · ${Math.round(total)}s`}
      </p>
      {script.notes && <p className="rounded-md border border-line bg-panel-2 p-2 text-xs text-dim">{script.notes}</p>}
      {writing && <WritingStatus stage={writing.stage} rewrite />}

      {issues.filter((i) => i.beatId === null).length > 0 && (
        <ul className="space-y-1 rounded-md border border-warn/30 bg-warn/5 p-2 text-xs text-warn">
          {issues.filter((i) => i.beatId === null).map((i, k) => <li key={k}>{i.message}</li>)}
        </ul>
      )}

      <ol className="space-y-3">
        {script.beats.map((b, i) => {
          const w = wordCount(b.narration);
          const budget = wordBudget(script.style, b.durationSec);
          const beatIssues = issues.filter((x) => x.beatId === b.id);
          return (
            <li key={b.id} className="rounded-lg border border-line bg-panel p-2.5" data-testid="script-beat">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="rounded bg-panel-2 px-1.5 text-[10px] font-semibold tabular-nums text-dim">{i + 1}</span>
                <span className="truncate text-xs font-medium">{b.purpose}</span>
                <span className="ml-auto shrink-0 [&_input]:h-7 [&_input]:w-16 [&_input]:px-2 [&_input]:py-0 [&_input]:text-xs" title="Beat length in seconds"><NumberField value={b.durationSec} min={1} max={60} step={0.5} suffix="s" onCommit={(v) => apply([{ op: "updateScriptBeat", beatId: b.id, patch: { durationSec: v } }])} /></span>
              </div>
              {script.narrated && (
                <>
                  <DebouncedText multiline ariaLabel={`Narration ${i + 1}`} value={b.narration} maxLength={1200} onCommit={(v) => apply([{ op: "updateScriptBeat", beatId: b.id, patch: { narration: v } }])} />
                  <div className={`mt-0.5 text-right text-[10px] tabular-nums ${w > budget * 1.15 + 1 ? "text-warn" : "text-faint"}`}>{w} / ~{budget} words</div>
                </>
              )}
              <label className="mt-1 block text-[10px] uppercase tracking-wider text-faint">On screen</label>
              <DebouncedText ariaLabel={`On-screen line ${i + 1}`} value={b.onScreen} maxLength={220} onCommit={(v) => apply([{ op: "updateScriptBeat", beatId: b.id, patch: { onScreen: v } }])} />
              {beatIssues.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 text-[11px] text-warn">
                  {beatIssues.map((x, k) => <li key={k}>{x.message}</li>)}
                </ul>
              )}
            </li>
          );
        })}
      </ol>

      <div className="space-y-2 rounded-lg border border-line p-2.5">
        <label className="label" htmlFor="script-note">Ask for a rewrite</label>
        <textarea id="script-note" className="input min-h-14" maxLength={1000} placeholder="e.g. Open with the problem, not the product. Explain focus time before naming it." value={note} onChange={(e) => setNote(e.target.value)} />
        <details className="text-xs">
          <summary className="cursor-pointer text-dim">Style and voiceover</summary>
          <div className="mt-2">{setup}</div>
        </details>
        <button className="btn w-full" disabled={!claudeReady || !!busy || !!writing} onClick={() => void write(true)}>{busy === "write" ? "Starting…" : note.trim() ? "Rewrite with this note" : "Rewrite"}</button>
      </div>

      {approved ? (
        <p className="text-xs text-ok">{planning ? "Approved — Claude is planning the storyboard around it." : "Approved. Editing any line reopens it for approval."}</p>
      ) : (
        <div className="space-y-1">
          <button className="btn btn-primary w-full" disabled={!claudeReady || !!busy || !!writing || !!planning} onClick={() => void approve()}>{busy === "approve" ? "Approving…" : "Approve script & plan storyboard"}</button>
          <p className="text-[11px] text-faint">
            Claude builds one scene per beat and keeps your narration word for word{script.narrated && script.next.voiceId ? "; the voiceover is recorded after planning" : ""}.
            {issues.length > 0 ? ` ${issues.length} style note${issues.length > 1 ? "s" : ""} above — fix or approve as is.` : ""}
          </p>
        </div>
      )}
      {failed && !writing && lastWrite?.id === failed.id && <p className="text-xs text-bad" role="alert">Rewrite failed: {failed.error?.message} {failed.error?.recovery}</p>}
      {err && <p className="text-xs text-bad" role="alert">{err}</p>}
    </section>
  );
}

function WritingStatus({ stage, rewrite }: { stage: string; rewrite?: boolean }) {
  return (
    <p className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent/5 p-2 text-sm text-dim" role="status" aria-live="polite">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
      {rewrite ? "Claude is rewriting the script" : "Claude is writing the script"}
      {stage && stage !== "queued" ? ` (${stage})` : "…"}
    </p>
  );
}
