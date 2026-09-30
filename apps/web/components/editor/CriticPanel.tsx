"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectDocument } from "@vs/domain";
import { api, ApiError } from "@/lib/client/api";
import type { JobDTO } from "./types";

type Severity = "fix" | "improve" | "nit";
interface Finding {
  id: string;
  scene: number;
  sceneId: string | null;
  frame: number;
  category: string;
  severity: Severity;
  observation: string;
  suggestion: string;
  request: string;
}
interface Critique {
  id: string;
  revisionId: string;
  createdAt: string;
  report: {
    summary: string;
    scores: { story: number; visuals: number; readability: number; pacing: number };
    strengths: string[];
    findings: Finding[];
    frames: { n: number; sceneId: string; sceneIndex: number; timeSec: number; kind: string; url: string }[];
    measured: { code: string; message: string }[];
    focus: string | null;
    limitations: string[];
    elapsedSec: number;
  };
}

const SEV: Record<Severity, [string, string]> = { fix: ["Fix", "border-bad/40 text-bad"], improve: ["Improve", "border-warn/40 text-warn"], nit: ["Nit", "border-line text-faint"] };
const SCORE_LABEL = { story: "Story", visuals: "Visuals", readability: "Readability", pacing: "Pacing" } as const;
/** The assistant takes one request of at most 2000 characters. */
const MAX_REQUEST = 1900;

/**
 * Visual critic (Phase 3): Claude reviews rendered frames like an editor. Select findings and
 * apply them through the assistant (claims and locks stay protected), then review again to check.
 */
export function CriticPanel({ projectId, doc, revisionId, jobs, revRef, claudeReady, onJump }: { projectId: string; doc: ProjectDocument; revisionId: string; jobs: JobDTO[]; revRef: { current: string | null }; claudeReady: boolean; onJump: (sceneId: string, timeSec: number) => void }) {
  const [critiques, setCritiques] = useState<Critique[]>([]);
  const [focus, setFocus] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applyJob, setApplyJob] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const running = jobs.find((j) => j.type === "critique" && ["queued", "running"].includes(j.status));
  const failed = jobs.find((j) => j.type === "critique" && ["failed", "paused"].includes(j.status));
  const lastCritiqueJob = jobs.find((j) => j.type === "critique");
  const applying = applyJob ? jobs.find((j) => j.id === applyJob) : undefined;
  const load = useCallback(() => api<{ critiques: Critique[] }>(`/api/projects/${projectId}/critique`).then((r) => setCritiques(r.critiques)).catch(() => {}), [projectId]);
  useEffect(() => {
    void load();
  }, [load, lastCritiqueJob?.status]);

  const latest = critiques[0];
  const previous = critiques[1];
  const fixable = useMemo(() => (latest?.report.findings ?? []).filter((f) => f.request && !(f.sceneId && doc.scenes.find((s) => s.id === f.sceneId)?.locked)), [latest, doc.scenes]);
  useEffect(() => {
    // Preselect what matters: every fixable "fix" and "improve".
    setSelected(new Set(fixable.filter((f) => f.severity !== "nit").map((f) => f.id)));
  }, [latest?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const errorOf = (e: unknown) => (e instanceof ApiError ? `${e.message}${e.recovery ? ` — ${e.recovery}` : ""}` : e instanceof Error ? e.message : String(e));

  const review = async () => {
    setErr(null);
    setBusy("review");
    try {
      await api(`/api/projects/${projectId}/critique`, { method: "POST", idempotent: true, json: { revisionId, ...(focus.trim() ? { focus: focus.trim() } : {}) } });
    } catch (e) {
      setErr(errorOf(e));
    } finally {
      setBusy(null);
    }
  };

  const applySelected = async () => {
    if (!latest) return;
    const chosen = latest.report.findings.filter((f) => selected.has(f.id) && f.request);
    if (!chosen.length) return;
    let request = "Apply these review notes. Change only what each note asks; keep all other text, approved claims and timing as they are.\n";
    const used: Finding[] = [];
    for (const f of chosen) {
      const line = `- ${f.scene > 0 ? `Scene ${f.scene} (${doc.scenes[f.scene - 1]?.purpose ?? ""})` : "Whole video"}: ${f.request}\n`;
      if (request.length + line.length > MAX_REQUEST) break;
      request += line;
      used.push(f);
    }
    const scenes = used.some((f) => !f.sceneId) ? [] : [...new Set(used.map((f) => f.sceneId!))];
    setErr(null);
    setBusy("apply");
    try {
      const r = await api<{ job: JobDTO }>(`/api/projects/${projectId}/assistant`, { method: "POST", idempotent: true, json: { baseRevisionId: revRef.current, request, selectedSceneIds: scenes } });
      setApplyJob(r.job.id);
      if (used.length < chosen.length) setErr(`Applied the first ${used.length} notes; apply the rest after this one finishes.`);
    } catch (e) {
      setErr(errorOf(e));
    } finally {
      setBusy(null);
    }
  };

  const frameOf = (f: Finding) => latest?.report.frames.find((x) => x.n === f.frame);
  return (
    <section aria-label="Critic" className="space-y-4">
      <div>
        <h2 className="panel-title">Critic</h2>
        <p className="mt-1 text-xs text-dim">Claude looks at real frames of this version, with the script and timings, and reviews it like an editor. Nothing changes until you apply a note.</p>
      </div>
      <div className="space-y-1.5">
        <input className="input" aria-label="What should the critic focus on?" maxLength={500} placeholder="Optional focus, e.g. Is the hook strong enough? Is the end card readable?" value={focus} onChange={(e) => setFocus(e.target.value)} />
        <button className="btn btn-primary w-full" disabled={!claudeReady || !!busy || !!running} onClick={() => void review()}>
          {running ? `Reviewing… ${running.stage}` : latest ? "Review this version again" : "Review this version"}
        </button>
        <p className="text-[11px] text-faint">Sends up to 16 frames and the script — one or two Claude requests on your plan.</p>
        {!claudeReady && <p className="text-xs text-warn">Claude is not available. Set it up in Settings → Claude.</p>}
      </div>
      {failed && !running && lastCritiqueJob?.id === failed.id && <p className="text-xs text-bad" role="alert">Review failed: {failed.error?.message} {failed.error?.recovery}</p>}
      {err && <p className="text-xs text-bad" role="alert">{err}</p>}

      {latest && (
        <div className="space-y-3" data-testid="critique">
          {latest.revisionId !== revisionId && <p className="rounded bg-warn/10 px-2 py-1 text-[11px] text-warn">This review is of an earlier version. Review again to check your latest edits.</p>}
          <div className="grid grid-cols-4 gap-1.5">
            {(Object.keys(SCORE_LABEL) as (keyof typeof SCORE_LABEL)[]).map((k) => {
              const v = latest.report.scores[k];
              const d = previous ? v - previous.report.scores[k] : 0;
              return (
                <div key={k} className="rounded-md border border-line bg-panel p-1.5 text-center" data-testid={`score-${k}`}>
                  <div className="text-[10px] uppercase tracking-wider text-faint">{SCORE_LABEL[k]}</div>
                  <div className="text-base font-semibold tabular-nums">
                    {v}
                    <span className="text-xs text-faint">/5</span>
                    {d !== 0 && <span className={`ml-1 text-[11px] ${d > 0 ? "text-ok" : "text-bad"}`}>{d > 0 ? `+${d}` : d}</span>}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-sm">{latest.report.summary}</p>
          {latest.report.strengths.length > 0 && (
            <ul className="space-y-0.5 text-xs text-dim">
              {latest.report.strengths.map((s, i) => <li key={i}><span className="text-ok">✓</span> {s}</li>)}
            </ul>
          )}

          <ol className="space-y-2">
            {latest.report.findings.map((f) => {
              const fr = frameOf(f);
              const canApply = fixable.some((x) => x.id === f.id);
              return (
                <li key={f.id} className="rounded-lg border border-line bg-panel p-2" data-testid="finding">
                  <div className="flex gap-2">
                    {fr ? (
                      <button className="shrink-0" onClick={() => onJump(fr.sceneId, fr.timeSec)} title={`Show ${fr.timeSec.toFixed(1)}s in the player`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={fr.url} alt={`Frame ${fr.n}`} className="h-12 w-20 rounded object-cover ring-1 ring-line" />
                      </button>
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1 text-[10px]">
                        <span className={`rounded border px-1 ${SEV[f.severity][1]}`}>{SEV[f.severity][0]}</span>
                        <span className="text-faint">{f.scene > 0 ? `Scene ${f.scene}` : "Whole video"} · {f.category}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-dim">{f.observation}</p>
                      <p className="mt-0.5 text-xs text-ink">{f.suggestion}</p>
                    </div>
                  </div>
                  {canApply ? (
                    <label className="mt-1.5 flex items-start gap-1.5 text-[11px] text-faint">
                      <input type="checkbox" className="mt-0.5" checked={selected.has(f.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(f.id); else n.delete(f.id); return n; })} aria-label={`Apply: ${f.suggestion}`} />
                      <span>Assistant will: {f.request}</span>
                    </label>
                  ) : (
                    <p className="mt-1.5 text-[11px] text-faint">{f.request ? "Scene is locked — unlock it to apply." : "Needs you (not something the assistant can do)."}</p>
                  )}
                </li>
              );
            })}
          </ol>
          {latest.report.findings.length === 0 && <p className="text-xs text-dim">No findings.</p>}

          {fixable.length > 0 && (
            <div className="space-y-1">
              <button className="btn w-full" disabled={!claudeReady || !!busy || selected.size === 0 || (!!applying && ["queued", "running"].includes(applying.status))} onClick={() => void applySelected()}>
                {applying && ["queued", "running"].includes(applying.status) ? "Applying with the assistant…" : `Apply ${selected.size} selected with the assistant`}
              </button>
              {applying?.status === "succeeded" && (
                <p className="text-[11px] text-ok">
                  {(applying.result as { status?: string; message?: string; explanation?: string } | null)?.status === "rejected_stale" ? (applying.result as { message?: string }).message : `Applied: ${(applying.result as { explanation?: string } | null)?.explanation ?? "done"}. Review again to check the result.`}
                </p>
              )}
              {applying && ["failed", "paused"].includes(applying.status) && <p className="text-[11px] text-bad">{applying.error?.message}</p>}
            </div>
          )}

          {latest.report.measured.length > 0 && <p className="text-[11px] text-faint">{latest.report.measured.length} measured issue{latest.report.measured.length > 1 ? "s" : ""} (text fit, captions, timeline) are handled by Quality review in the Export tab.</p>}
          <details className="text-xs">
            <summary className="cursor-pointer text-dim">Frames reviewed ({latest.report.frames.length})</summary>
            <div className="mt-2 grid grid-cols-4 gap-1">
              {latest.report.frames.map((fr) => (
                <button key={fr.n} onClick={() => onJump(fr.sceneId, fr.timeSec)} title={`Image ${fr.n} · scene ${fr.sceneIndex + 1} · ${fr.timeSec.toFixed(1)}s`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={fr.url} alt={`Frame ${fr.n}`} className="aspect-video w-full rounded object-cover ring-1 ring-line" />
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-faint">{latest.report.limitations.join(" ")}</p>
          </details>
        </div>
      )}
    </section>
  );
}
