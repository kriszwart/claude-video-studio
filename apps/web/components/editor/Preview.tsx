"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { computeTimeline, type ProjectDocument } from "@vs/domain";
import { api, ApiError, fmtDuration } from "@/lib/client/api";
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
  const [err, setErr] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const timeline = useMemo(() => computeTimeline(doc), [doc]);
  const total = timeline.totalFrames / doc.format.fps;
  const current = exports.find((e) => e.revisionId === revisionId);
  const shown = current ?? exports[0];
  const stale = !!shown && shown.revisionId !== revisionId;
  const running = jobs.find((j) => (j.type === "preview" || j.type === "export") && ["queued", "running", "cancel_requested"].includes(j.status));
  const failed = jobs.find((j) => (j.type === "preview" || j.type === "export") && j.status === "failed" && j.revisionId === revisionId);

  const render = async () => {
    setErr(null);
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

  const seekScene = (sceneId: string) => {
    onSelectScene(sceneId);
    const t = timeline.scenes.find((s) => s.sceneId === sceneId);
    if (t && video.current) video.current.currentTime = t.start / doc.format.fps + 0.01;
  };
  const aspectClass = doc.format.aspect === "9:16" ? "aspect-[9/16] max-h-[62vh]" : doc.format.aspect === "1:1" ? "aspect-square max-h-[62vh]" : "aspect-video";

  return (
    <section aria-label="Preview" className="flex min-h-0 flex-col gap-3">
      <div className="relative flex items-center justify-center rounded-lg border border-line bg-black">
        <div className={`relative w-full ${aspectClass} mx-auto`}>
          {shown ? (
            <video ref={video} key={shown.id} src={shown.videoUrl} poster={shown.thumbUrl ?? undefined} controls playsInline className="absolute inset-0 h-full w-full" aria-label="Rendered draft preview" />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-dim">
              <p>No rendered draft yet. The draft is the authority for what the final video looks and sounds like.</p>
            </div>
          )}
          {stale && (
            <div className="absolute left-2 top-2 rounded bg-warn/90 px-2 py-0.5 text-xs font-medium text-black" role="status">
              Out of date — shows revision before your latest edits
            </div>
          )}
        </div>
      </div>

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
          {shown && !stale && <div className="pointer-events-none absolute bottom-0 top-0 w-px bg-accent" style={{ left: `${Math.min(100, (time / total) * 100)}%` }} />}
        </div>
      </div>
    </section>
  );
}
