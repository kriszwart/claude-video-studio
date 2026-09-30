"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { computeTimeline, type ProjectDocument } from "@vs/domain";
import { api, ApiError, fmtDuration } from "@/lib/client/api";
import { LivePlayer, type LivePlayerHandle, type LiveState } from "./LivePlayer";
import type { ExportDTO, JobDTO } from "./types";

export function Preview({
  projectId,
  doc,
  revisionId,
  exports,
  jobs,
  selectedSceneId,
  onSelectScene,
  blockingIssues,
}: {
  projectId: string;
  doc: ProjectDocument;
  revisionId: string;
  exports: ExportDTO[];
  jobs: JobDTO[];
  selectedSceneId: string | null;
  onSelectScene: (id: string) => void;
  blockingIssues: string[];
}) {
  const video = useRef<HTMLVideoElement>(null);
  const live = useRef<LivePlayerHandle>(null);
  const [mode, setMode] = useState<"live" | "rendered">("live");
  const [liveState, setLiveState] = useState<LiveState | null>(null);
  const [muted, setMuted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [videoTime, setTime] = useState(0);
  const time = mode === "live" ? (liveState?.time ?? 0) : videoTime;
  const timeline = useMemo(() => computeTimeline(doc), [doc]);
  const total = timeline.totalFrames / doc.format.fps;
  const current = exports.find((e) => e.revisionId === revisionId);
  const shown = current ?? exports[0];
  const stale = !!shown && shown.revisionId !== revisionId;
  const running = jobs.find((j) => (j.type === "preview" || j.type === "export") && ["queued", "running", "cancel_requested"].includes(j.status));
  const failed = jobs.find((j) => (j.type === "preview" || j.type === "export") && j.status === "failed" && j.revisionId === revisionId);

  // After a draft render you started finishes, show it (the rendered file is the authority).
  const [awaitingRender, setAwaitingRender] = useState(false);
  useEffect(() => {
    if (awaitingRender && current) {
      setMode("rendered");
      setAwaitingRender(false);
    }
  }, [awaitingRender, current?.id]);

  const render = async () => {
    setErr(null);
    setAwaitingRender(true);
    try {
      await api(`/api/projects/${projectId}/preview`, { method: "POST", idempotent: true, json: { revisionId } });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const onTime = () => setTime(v.currentTime);
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [shown?.id]);

  const seekTo = (sec: number) => {
    if (mode === "live") live.current?.seek(sec);
    else if (video.current) video.current.currentTime = sec;
  };
  const seekScene = (sceneId: string) => {
    onSelectScene(sceneId);
    const t = timeline.scenes.find((s) => s.sceneId === sceneId);
    if (t) seekTo(t.start / doc.format.fps + 0.01);
  };
  // Space plays/pauses the live preview; ←/→ step 1 s (Shift: one frame). Ignored while typing.
  useEffect(() => {
    if (mode !== "live") return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(t.tagName))) return;
      if (e.key === " ") {
        e.preventDefault();
        live.current?.toggle();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = e.shiftKey ? 1 / doc.format.fps : 1;
        live.current?.seek(Math.max(0, Math.min(total, time + (e.key === "ArrowLeft" ? -step : step))));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, time, total, doc.format.fps]);
  const aspectClass = doc.format.aspect === "9:16" ? "aspect-[9/16] max-h-[62vh]" : doc.format.aspect === "1:1" ? "aspect-square max-h-[62vh]" : "aspect-video";

  return (
    <section aria-label="Preview" className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center gap-1 text-xs" role="tablist" aria-label="Preview mode">
        <button role="tab" aria-selected={mode === "live"} className={`btn btn-ghost px-2 py-0.5 text-xs ${mode === "live" ? "bg-panel-2 text-ink" : "text-dim"}`} onClick={() => setMode("live")}>Live</button>
        <button role="tab" aria-selected={mode === "rendered"} className={`btn btn-ghost px-2 py-0.5 text-xs ${mode === "rendered" ? "bg-panel-2 text-ink" : "text-dim"}`} onClick={() => setMode("rendered")}>Rendered draft</button>
        <span className="ml-2 text-faint">{mode === "live" ? "Plays your latest edits instantly — the same composition the export renders." : "The last rendered MP4 (the authority for final pixels and sound)."}</span>
      </div>
      <div className="relative flex items-center justify-center rounded-lg border border-line bg-black">
        <div className={`relative w-full ${aspectClass} mx-auto`}>
          {mode === "live" ? (
            <LivePlayer ref={live} projectId={projectId} revisionId={revisionId} onState={setLiveState} muted={muted} />
          ) : shown ? (
            <video ref={video} key={shown.id} src={shown.videoUrl} poster={shown.thumbUrl ?? undefined} controls playsInline className="absolute inset-0 h-full w-full" aria-label="Rendered draft preview" />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-dim">
              <p>No rendered draft yet. The draft is the authority for what the final video looks and sounds like.</p>
            </div>
          )}
          {mode === "rendered" && stale && (
            <div className="absolute left-2 top-2 rounded bg-warn/90 px-2 py-0.5 text-xs font-medium text-black" role="status">
              Out of date — shows revision before your latest edits
            </div>
          )}
        </div>
      </div>

      {mode === "live" && (
        <div className="flex items-center gap-2" aria-label="Playback">
          <button className="btn w-20 text-xs" onClick={() => live.current?.toggle()} disabled={!liveState?.ready} aria-label={liveState?.playing ? "Pause" : "Play"}>
            {liveState?.playing ? "❚❚ Pause" : "▶ Play"}
          </button>
          <input
            type="range"
            aria-label="Scrub"
            className="flex-1 accent-[var(--color-accent,#7c6cff)]"
            min={0}
            max={total}
            step={1 / doc.format.fps}
            value={Math.min(time, total)}
            disabled={!liveState?.ready}
            onChange={(e) => live.current?.seek(Number(e.target.value), "drag")}
            onPointerUp={(e) => live.current?.seek(Number((e.target as HTMLInputElement).value), "commit")}
          />
          <button className="btn btn-ghost px-2 text-xs" onClick={() => setMuted(!muted)} aria-pressed={muted} aria-label={muted ? "Unmute" : "Mute"}>{muted ? "🔇" : "🔊"}</button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" onClick={render} disabled={!!running || blockingIssues.length > 0} title={blockingIssues.join("\n")}>
          {running ? "Rendering…" : current ? "Re-render draft" : "Render draft with audio"}
        </button>
        {running && (
          <span className="text-xs text-dim" aria-live="polite">
            {running.type === "export" ? "Export" : "Draft"}: {running.status === "queued" ? "queued" : running.stage}
            {running.progress != null && running.status === "running" ? ` · ${Math.round(running.progress * 100)}%` : ""}
            <button className="ml-2 underline" onClick={() => api(`/api/jobs/${running.id}/cancel`, { method: "POST" })}>Cancel</button>
          </span>
        )}
        {!running && failed && (
          <span className="text-xs text-bad" role="alert">
            Last render failed: {failed.error?.message}{" "}
            {failed.error?.recovery && <span className="text-dim">{failed.error.recovery}</span>}
            <button className="ml-2 underline" onClick={() => api(`/api/jobs/${failed.id}/retry`, { method: "POST" }).catch((e) => setErr(e.message))}>Retry</button>
          </span>
        )}
        {blockingIssues.length > 0 && <span className="text-xs text-bad">Fix {blockingIssues.length} timeline error(s) before rendering.</span>}
        {err && <span className="text-xs text-bad" role="alert">{err}</span>}
        <span className="ml-auto font-mono text-xs text-faint">
          {fmtDuration(time)} / {fmtDuration(total)} · {doc.format.aspect} · 30 fps
        </span>
      </div>

      <div className="overflow-x-auto" aria-label="Timeline" role="group">
        <div className="relative h-12 min-w-[480px] rounded-md border border-line bg-panel">
          {timeline.scenes.map((t, i) => {
            const s = doc.scenes[i]!;
            const left = (t.start / timeline.totalFrames) * 100;
            const width = (t.duration / timeline.totalFrames) * 100;
            return (
              <button
                key={s.id}
                onClick={() => seekScene(s.id)}
                className={`absolute top-1 h-10 overflow-hidden rounded border px-1.5 text-left text-[11px] leading-tight ${selectedSceneId === s.id ? "border-accent bg-accent/20" : "border-line bg-panel-2 hover:border-faint"}`}
                style={{ left: `${left}%`, width: `calc(${width}% - 2px)` }}
                title={`${i + 1}. ${s.purpose} · ${(t.duration / 30).toFixed(1)}s${t.overlapIn ? ` · ${s.transitionIn.type} ${(t.overlapIn / 30).toFixed(2)}s overlap` : ""}`}
              >
                <span className="block truncate">{i + 1}. {s.purpose}</span>
                <span className="text-faint">{(t.duration / 30).toFixed(1)}s{s.locked ? " · 🔒" : ""}</span>
              </button>
            );
          })}
          {(mode === "live" ? !!liveState?.ready : shown && !stale) && <div className="pointer-events-none absolute bottom-0 top-0 w-px bg-accent" style={{ left: `${Math.min(100, (time / total) * 100)}%` }} />}
        </div>
      </div>
    </section>
  );
}
