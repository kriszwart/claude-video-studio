"use client";
import { useState } from "react";
import { computeTimeline, type Operation, type ProjectDocument, type Scene } from "@vs/domain";
import { api, ApiError, fmtDuration } from "@/lib/client/api";
import type { JobDTO, ProjectViewDTO } from "./types";

const TRANSITION: Record<string, string> = { cut: "Cut", fade: "Fade", slide: "Slide", wipe: "Wipe", zoom: "Zoom" };

/**
 * Shot-plan review (Phase 2): Claude's storyboard as real frames, one card per scene, before any
 * voiceover is recorded or draft rendered. Revise single shots with a note, replan everything,
 * or approve — approval records the voiceover (and optionally renders a draft).
 */
export function ShotPlanReview({
  projectId,
  doc,
  view,
  apply,
  revRef,
  revisionId,
  refresh,
  claudeReady,
  onOpenScene,
  onDismiss,
}: {
  projectId: string;
  doc: ProjectDocument;
  view: ProjectViewDTO;
  apply: (ops: Operation[]) => Promise<boolean>;
  revRef: { current: string | null };
  /** The revision this screen is showing. */
  revisionId: string;
  refresh: () => Promise<void>;
  claudeReady: boolean;
  onOpenScene: (sceneId: string) => void;
  onDismiss: () => void;
}) {
  const timeline = computeTimeline(doc);
  const total = timeline.totalFrames / doc.format.fps;
  const plan = view.jobs.find((j) => j.type === "plan" && j.status === "succeeded");
  const planning = view.jobs.find((j) => j.type === "plan" && ["queued", "running"].includes(j.status));
  const result = (plan?.result ?? {}) as { rationale?: string; warnings?: string[]; omitted?: { recipeSlot: string; reason: string }[] };
  const [revising, setRevising] = useState<Record<string, string>>({}); // sceneId → jobId
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [replanNote, setReplanNote] = useState("");
  const [showReplan, setShowReplan] = useState(false);
  const [render, setRender] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const voiceId = doc.review?.next.voiceId;
  const narrated = doc.scenes.some((s) => s.script.narration.trim());
  const needsMedia = doc.scenes.filter((s) => s.status.state === "needs_input");
  const [aw, ah] = doc.format.aspect.split(":").map(Number) as [number, number];
  const jobById = new Map(view.jobs.map((j) => [j.id, j]));
  const errorOf = (e: unknown) => (e instanceof ApiError ? `${e.message}${e.recovery ? ` — ${e.recovery}` : ""}` : e instanceof Error ? e.message : String(e));

  const revise = async (scene: Scene) => {
    const request = (notes[scene.id] ?? "").trim();
    if (!request) return;
    setErr(null);
    try {
      const r = await api<{ job: JobDTO }>(`/api/projects/${projectId}/assistant`, { method: "POST", idempotent: true, json: { baseRevisionId: revRef.current, request, selectedSceneIds: [scene.id] } });
      setRevising((m) => ({ ...m, [scene.id]: r.job.id }));
      setNotes((n) => ({ ...n, [scene.id]: "" }));
      setOpenNote(null);
    } catch (e) {
      setErr(errorOf(e));
    }
  };

  const replan = async () => {
    setErr(null);
    setBusy("replan");
    try {
      await api(`/api/projects/${projectId}/plan`, { method: "POST", idempotent: true, json: { baseRevisionId: revRef.current, review: true, ...(replanNote.trim() ? { note: replanNote.trim() } : {}), ...(voiceId ? { narration: { voiceId } } : {}) } });
      setShowReplan(false);
      setReplanNote("");
    } catch (e) {
      setErr(errorOf(e));
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    setErr(null);
    setBusy("approve");
    try {
      // Approve only what is on screen: if a newer plan landed meanwhile, show it first.
      await refresh();
      if (revRef.current !== revisionId) throw new Error("The shot plan just changed. Review the new version, then approve.");
      if (!(await apply([{ op: "setReviewStatus", status: "approved" }]))) throw new Error("Could not save the approval.");
      if (voiceId && narrated) await api(`/api/projects/${projectId}/narration`, { method: "POST", idempotent: true, json: { voiceId, rate: 1, fit: "extend" } });
      // With a voiceover the draft waits for it: the owner renders once narration lands.
      else if (render) await api(`/api/projects/${projectId}/preview`, { method: "POST", idempotent: true, json: { revisionId: revRef.current } });
      onDismiss();
    } catch (e) {
      setErr(errorOf(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Shot plan" className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">Shot plan</h1>
            <p className="text-sm text-dim">
              {doc.scenes.length} shots · {fmtDuration(total)} · {doc.format.aspect}
              {doc.script?.status === "approved" ? " · follows your approved script" : ""}
            </p>
            {result.rationale && <p className="mt-2 max-w-3xl text-sm text-dim">{result.rationale}</p>}
          </div>
          <button className="btn btn-ghost text-xs" onClick={onDismiss}>Open the editor</button>
        </div>
        {(result.warnings?.length || result.omitted?.length || needsMedia.length) ? (
          <ul className="space-y-1 rounded-md border border-warn/30 bg-warn/5 p-3 text-xs text-warn">
            {needsMedia.length > 0 && <li>{needsMedia.length} shot{needsMedia.length > 1 ? "s need" : " needs"} media you haven't supplied — add it in the editor, or ask Claude to revise the shot without it.</li>}
            {result.omitted?.map((o, i) => <li key={`o${i}`}>Left out “{o.recipeSlot}”: {o.reason}</li>)}
            {result.warnings?.map((w, i) => <li key={`w${i}`}>{w}</li>)}
          </ul>
        ) : null}
        {planning && (
          <p className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent/5 p-2 text-sm text-dim" role="status">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" /> Claude is replanning the storyboard ({planning.stage})…
          </p>
        )}

        <ol className={`grid gap-3 ${aw < ah ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"}`}>
          {doc.scenes.map((s, i) => {
            const kf = view.keyframes[s.id];
            const job = revising[s.id] ? jobById.get(revising[s.id]!) : undefined;
            const busyScene = job && ["queued", "running"].includes(job.status);
            const texts = s.layers.filter((l) => l.kind === "text" && !l.hidden).map((l) => (l.kind === "text" ? l.text : "")).filter(Boolean);
            const start = (timeline.scenes.find((t) => t.sceneId === s.id)?.start ?? 0) / doc.format.fps;
            return (
              <li key={s.id} className="card flex flex-col overflow-hidden" data-testid="shot-card">
                <div className="relative bg-black" style={{ aspectRatio: `${aw} / ${ah}` }}>
                  {kf ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={kf.url} alt={`Frame from shot ${i + 1}`} className={`h-full w-full object-cover ${kf.fresh ? "" : "opacity-50"}`} />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-faint">rendering frame…</div>
                  )}
                  <span className="absolute left-2 top-2 rounded bg-black/75 px-1.5 text-[11px] font-semibold tabular-nums text-white">{i + 1}</span>
                  <span className="absolute right-2 top-2 rounded bg-black/75 px-1.5 text-[10px] tabular-nums text-white">{fmtDuration(start)} · {(s.durationFrames / doc.format.fps).toFixed(1)}s</span>
                  {i > 0 && <span className="absolute bottom-2 left-2 rounded bg-black/75 px-1.5 text-[10px] text-white/80">{TRANSITION[s.transitionIn.type] ?? s.transitionIn.type} in</span>}
                  {s.status.state === "needs_input" && <span className="absolute bottom-2 right-2 rounded bg-warn/90 px-1.5 text-[10px] font-medium text-black">needs media</span>}
                  {busyScene && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-xs text-white" role="status">
                      <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-accent" /> Claude is revising this shot…
                    </div>
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-1.5 p-3">
                  <div className="text-sm font-medium">{s.purpose}</div>
                  {texts.length > 0 && <div className="text-xs text-ink/90">{texts.join(" · ")}</div>}
                  {s.script.narration.trim() && <p className="text-xs italic text-dim">“{s.script.narration.trim()}”</p>}
                  {job?.status === "succeeded" && (job.result as { status?: string; explanation?: string } | null)?.status !== "rejected_stale" && <p className="text-[11px] text-ok">Revised: {(job.result as { explanation?: string } | null)?.explanation}</p>}
                  {job && ["failed", "paused"].includes(job.status) && <p className="text-[11px] text-bad">{job.error?.message}</p>}
                  {job?.status === "succeeded" && (job.result as { status?: string; message?: string } | null)?.status === "rejected_stale" && <p className="text-[11px] text-warn">{(job.result as { message?: string }).message}</p>}
                  <div className="mt-auto pt-1">
                    {openNote === s.id ? (
                      <div className="space-y-1.5">
                        <textarea
                          autoFocus
                          aria-label={`What should change in shot ${i + 1}?`}
                          className="input min-h-14 text-xs"
                          maxLength={2000}
                          placeholder="e.g. Show the dashboard screenshot instead; shorter headline."
                          value={notes[s.id] ?? ""}
                          onChange={(e) => setNotes((n) => ({ ...n, [s.id]: e.target.value }))}
                        />
                        <div className="flex gap-1">
                          <button className="btn btn-primary px-2 py-1 text-xs" disabled={!claudeReady || !(notes[s.id] ?? "").trim()} onClick={() => void revise(s)}>Revise shot</button>
                          <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => setOpenNote(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-1">
                        <button className="btn btn-ghost px-2 py-1 text-xs" disabled={!claudeReady || !!busyScene} onClick={() => setOpenNote(s.id)}>Revise…</button>
                        <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => onOpenScene(s.id)}>Edit</button>
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="sticky bottom-0 -mx-4 border-t border-line bg-panel/95 px-4 py-3 backdrop-blur">
          {showReplan && (
            <div className="mb-3 space-y-1.5">
              <label className="label" htmlFor="replan-note">What should change overall?</label>
              <textarea id="replan-note" className="input min-h-14" maxLength={1000} placeholder="e.g. Fewer, longer shots; open on the product screenshot; end on the offer." value={replanNote} onChange={(e) => setReplanNote(e.target.value)} />
              <div className="flex gap-1">
                <button className="btn px-3 text-xs" disabled={!claudeReady || !!busy || !!planning} onClick={() => void replan()}>{busy === "replan" ? "Starting…" : "Replan the storyboard"}</button>
                <button className="btn btn-ghost px-3 text-xs" onClick={() => setShowReplan(false)}>Cancel</button>
              </div>
              {doc.script?.status === "approved" && <p className="text-[11px] text-faint">The approved script stays word for word; replanning changes the visuals around it.</p>}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={!!busy || !!planning} onClick={() => void approve()}>
              {busy === "approve" ? "Approving…" : voiceId && narrated ? "Approve & record voiceover" : render ? "Approve & render a draft" : "Approve shot plan"}
            </button>
            {!(voiceId && narrated) && (
              <label className="flex items-center gap-1.5 text-xs text-dim">
                <input type="checkbox" checked={render} onChange={(e) => setRender(e.target.checked)} /> Render a draft with audio
              </label>
            )}
            {!showReplan && <button className="btn btn-ghost text-xs" disabled={!claudeReady || !!planning} onClick={() => setShowReplan(true)}>Replan with a note…</button>}
            <span className="ml-auto text-[11px] text-faint">{voiceId && narrated ? "The voiceover is recorded after approval; render once it lands." : "Frames are real renders of each shot's composition."}</span>
          </div>
          {err && <p className="mt-2 text-xs text-bad" role="alert">{err}</p>}
        </div>
      </div>
    </section>
  );
}
