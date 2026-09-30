"use client";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { computeTimeline, type ProjectDocument } from "@vs/domain";
import { api, ApiError, fmtDuration } from "@/lib/client/api";
import { LivePlayer, type LivePlayerHandle, type LiveState } from "./LivePlayer";
import type { ExportDTO, JobDTO } from "./types";

export interface PreviewClock {
  time: number;
  playing: boolean;
  ready: boolean;
}
export interface PreviewHandle {
  seek(sec: number, mode?: "drag" | "commit"): void;
}

/**
 * The editor's stage: the live player (default) or the last rendered draft, sized to fill the
 * available space at the project's aspect ratio, with transport and render controls. The
 * playhead clock is reported to the editor, which drives the timeline.
 */
export const Preview = forwardRef<
  PreviewHandle,
  {
    projectId: string;
    doc: ProjectDocument;
    revisionId: string;
    exports: ExportDTO[];
    jobs: JobDTO[];
    blockingIssues: string[];
    onClock?: (c: PreviewClock) => void;
  }
>(function Preview({ projectId, doc, revisionId, exports, jobs, blockingIssues, onClock }, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const live = useRef<LivePlayerHandle>(null);
  const [mode, setMode] = useState<"live" | "rendered">("live");
  const [liveState, setLiveState] = useState<LiveState | null>(null);
  const [muted, setMuted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [videoTime, setVideoTime] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const timeline = useMemo(() => computeTimeline(doc), [doc]);
  const total = timeline.totalFrames / doc.format.fps;
  const current = exports.find((e) => e.revisionId === revisionId);
  const shown = current ?? exports[0];
  const stale = !!shown && shown.revisionId !== revisionId;
  const running = jobs.find((j) => (j.type === "preview" || j.type === "export") && ["queued", "running", "cancel_requested"].includes(j.status));
  const failed = jobs.find((j) => (j.type === "preview" || j.type === "export") && j.status === "failed" && j.revisionId === revisionId);
  const time = mode === "live" ? (liveState?.time ?? 0) : videoTime;
  const playing = mode === "live" ? !!liveState?.playing : videoPlaying;
  const ready = mode === "live" ? !!liveState?.ready : !!shown;

  useEffect(() => {
    onClock?.({ time, playing, ready });
  }, [time, playing, ready, onClock]);

  const seek = (sec: number, m: "drag" | "commit" = "commit") => {
    if (mode === "live") live.current?.seek(sec, m);
    else if (video.current) video.current.currentTime = sec;
  };
  useImperativeHandle(ref, () => ({ seek }));
  const toggle = () => {
    if (mode === "live") live.current?.toggle();
    else if (video.current) void (video.current.paused ? video.current.play() : video.current.pause());
  };

  // After a draft render you started finishes, show it (the rendered file is the authority).
  const [awaitingRender, setAwaitingRender] = useState(false);
  useEffect(() => {
    if (awaitingRender && current) {
      setMode("rendered");
      setAwaitingRender(false);
    }
  }, [awaitingRender, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const render = async () => {
    setErr(null);
    setAwaitingRender(true);
    try {
      await api(`/api/projects/${projectId}/preview`, { method: "POST", idempotent: true, json: { revisionId } });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
      setAwaitingRender(false);
    }
  };

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const onTime = () => setVideoTime(v.currentTime);
    const onPlay = () => setVideoPlaying(true);
    const onPause = () => setVideoPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [shown?.id, mode]);

  // Space plays/pauses; ←/→ step 1 s (Shift: one frame). Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(t.tagName) || t.getAttribute("role") === "slider")) return;
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = e.shiftKey ? 1 / doc.format.fps : 1;
        seek(Math.max(0, Math.min(total, time + (e.key === "ArrowLeft" ? -step : step))));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const [aw, ah] = doc.format.aspect.split(":").map(Number) as [number, number];
  return (
    <section aria-label="Preview" className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-1 text-xs" role="tablist" aria-label="Preview mode">
        <button role="tab" aria-selected={mode === "live"} className={`seg ${mode === "live" ? "seg-on" : ""}`} onClick={() => setMode("live")}>Live</button>
        <button role="tab" aria-selected={mode === "rendered"} className={`seg ${mode === "rendered" ? "seg-on" : ""}`} onClick={() => setMode("rendered")}>Rendered draft</button>
        <span className="ml-2 hidden truncate text-faint xl:inline">{mode === "live" ? "Your latest edits, playing instantly — the same composition the export renders." : "The last rendered MP4 — the authority for final pixels and sound."}</span>
      </div>
      {/* Stage: fills the space at the project's aspect ratio. */}
      <div className="relative min-h-[220px] flex-1" style={{ containerType: "size" }}>
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg bg-black shadow-2xl ring-1 ring-line" style={{ width: `min(100cqw, calc(100cqh * ${aw / ah}))`, aspectRatio: `${aw} / ${ah}` }}>
          {mode === "live" ? (
            <LivePlayer ref={live} projectId={projectId} revisionId={revisionId} onState={setLiveState} muted={muted} />
          ) : shown ? (
            <video ref={video} key={shown.id} src={shown.videoUrl} poster={shown.thumbUrl ?? undefined} controls playsInline className="absolute inset-0 h-full w-full" aria-label="Rendered draft preview" />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-dim">
              <p>No rendered draft yet. Render one to hear the final mix and check the exact output.</p>
            </div>
          )}
          {mode === "rendered" && stale && (
            <div className="absolute left-2 top-2 rounded bg-warn/90 px-2 py-0.5 text-xs font-medium text-black" role="status">
              Out of date — shows a revision before your latest edits
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2" aria-label="Playback">
        <button className="btn btn-icon" onClick={() => seek(0)} disabled={!ready} aria-label="Go to start" title="Go to start">⏮</button>
        <button className="btn btn-play" onClick={toggle} disabled={!ready} aria-label={playing ? "Pause" : "Play"} title="Play/pause (Space)">
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="w-28 font-mono text-xs tabular-nums text-dim" aria-live="off">
          {fmtDuration(time)} / {fmtDuration(total)}
        </span>
        {mode === "live" && (
          <input
            type="range"
            aria-label="Scrub"
            className="scrub min-w-24 flex-1"
            min={0}
            max={total}
            step={1 / doc.format.fps}
            value={Math.min(time, total)}
            disabled={!ready}
            onChange={(e) => live.current?.seek(Number(e.target.value), "drag")}
            onPointerUp={(e) => live.current?.seek(Number((e.target as HTMLInputElement).value), "commit")}
          />
        )}
        {mode === "live" && (
          <button className="btn btn-icon" onClick={() => setMuted(!muted)} aria-pressed={muted} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}>
            {muted ? "🔇" : "🔊"}
          </button>
        )}
        <span className="ml-auto" />
        {running ? (
          <span className="text-xs text-dim" aria-live="polite">
            {running.type === "export" ? "Export" : "Draft"}: {running.status === "queued" ? "queued" : running.stage}
            {running.progress != null && running.status === "running" ? ` · ${Math.round(running.progress * 100)}%` : ""}
            <button className="ml-2 underline" onClick={() => api(`/api/jobs/${running.id}/cancel`, { method: "POST" })}>Cancel</button>
          </span>
        ) : null}
        <button className="btn btn-primary" onClick={render} disabled={!!running || blockingIssues.length > 0} title={blockingIssues.join("\n")}>
          {running ? "Rendering…" : current ? "Re-render draft" : "Render draft with audio"}
        </button>
      </div>
      {!running && failed && (
        <p className="text-xs text-bad" role="alert">
          Last render failed: {failed.error?.message} {failed.error?.recovery && <span className="text-dim">{failed.error.recovery}</span>}
          <button className="ml-2 underline" onClick={() => api(`/api/jobs/${failed.id}/retry`, { method: "POST" }).catch((e) => setErr(e.message))}>Retry</button>
        </p>
      )}
      {blockingIssues.length > 0 && <p className="text-xs text-bad">Fix {blockingIssues.length} timeline error(s) before rendering.</p>}
      {err && <p className="text-xs text-bad" role="alert">{err}</p>}
    </section>
  );
});
