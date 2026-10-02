"use client";
import { useState } from "react";
import { api } from "@/lib/client/api";
import type { FlowAction, FlowStep, projectFlow } from "./flow";

const DOT: Record<FlowStep["state"], string> = {
  done: "border-ok bg-ok/15 text-ok",
  working: "border-accent text-accent animate-pulse",
  next: "border-accent bg-accent text-accent-ink",
  todo: "border-line text-faint",
};

/**
 * Guided next step: the project's stages as a compact stepper, and one line saying what to do
 * now with a button that does it (or opens the panel where it's done).
 */
export function FlowBar({ flow, projectId, revisionId, onAction }: { flow: ReturnType<typeof projectFlow>; projectId: string; revisionId: string; onAction: (a: FlowAction) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { steps, next, skipTo } = flow;

  const run = async (a: FlowAction) => {
    setError(null);
    if (a.kind !== "render") return onAction(a);
    setBusy(true);
    try {
      await api(`/api/projects/${projectId}/preview`, { method: "POST", idempotent: true, json: { revisionId } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <nav aria-label="Project steps" data-testid="flow-bar" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-black/60 bg-[#191919] px-2 py-1 text-[12px]">
      <ol className="flex items-center gap-1 overflow-x-auto">
        {steps.map((s, i) => (
          <li key={s.id} className="flex shrink-0 items-center gap-1">
            {i > 0 && <span aria-hidden className={`h-px w-3 ${steps[i - 1]!.state === "done" ? "bg-ok/60" : "bg-line"}`} />}
            <button
              type="button"
              className={`flex items-center gap-1 rounded-[3px] px-1.5 py-1 hover:bg-panel-2 ${s.state === "next" ? "font-medium text-ink shadow-[inset_0_-2px_0_var(--color-sel)]" : s.state === "todo" ? "text-faint" : "text-dim"}`}
              disabled={!s.action || s.action.kind === "render"}
              title={s.hint}
              aria-current={s === next ? "step" : undefined}
              data-step={s.id}
              data-state={s.state}
              onClick={() => s.action && void run(s.action)}
            >
              <span className={`grid h-4 w-4 place-items-center rounded-full border text-[9px] ${DOT[s.state]}`}>{s.state === "done" ? "✓" : i + 1}</span>
              {s.label}
              {s.optional && <span className="text-faint">(optional)</span>}
            </button>
          </li>
        ))}
      </ol>
      <div className="ml-auto flex min-w-0 items-center gap-2" aria-live="polite">
        {next ? (
          <>
            <span className="min-w-0 truncate text-dim" data-testid="flow-hint" title={next.hint}>
              <span className={next.state === "working" ? "text-accent" : "text-ink"}>{next.state === "working" ? "In progress" : "Next"}:</span> {next.hint}
            </span>
            {next.action && next.actionLabel && (
              <button className={`btn shrink-0 px-2 py-0.5 text-xs ${next.state === "next" ? "btn-primary" : ""}`} disabled={busy} data-testid="flow-next" onClick={() => void run(next.action!)}>
                {busy ? "Starting…" : next.actionLabel}
              </button>
            )}
            {skipTo?.action && (
              <button className="btn btn-ghost shrink-0 px-2 py-0.5 text-xs" onClick={() => void run(skipTo.action!)}>
                Skip to {skipTo.label.toLowerCase()}
              </button>
            )}
          </>
        ) : (
          <span className="text-ok">All steps done for this version.</span>
        )}
        {error && <span className="text-bad">{error}</span>}
      </div>
    </nav>
  );
}
