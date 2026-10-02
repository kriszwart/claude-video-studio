"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { validateTimeline } from "@vs/domain";
import { api } from "@/lib/client/api";
import { useClaudeStatus } from "@/lib/client/claude";
import { AssistantPanel } from "./AssistantPanel";
import { AudioPanel } from "./AudioPanel";
import { ExportPanel } from "./ExportPanel";
import { LanternistPanel } from "./LanternistPanel";
import { QualityPanel } from "./QualityPanel";
import { DebouncedText } from "./fields";
import { Preview, type PreviewClock, type PreviewHandle } from "./Preview";
import { Timeline } from "./Timeline";
import { ProgramPanel } from "./ProgramPanel";
import { ShotsPanel } from "./ShotsPanel";
import { ProjectPanel } from "./ProjectPanel";
import { SceneInspector } from "./SceneInspector";
import { SceneList } from "./SceneList";
import { ScriptPanel } from "./ScriptPanel";
import { CriticPanel } from "./CriticPanel";
import { ShotPlanReview } from "./ShotPlanReview";
import { useProject } from "./useProject";
import { FlowBar } from "./FlowBar";
import { projectFlow, type FlowAction } from "./flow";
import { LogoMark } from "@/components/Logo";

type Tab = "script" | "critic" | "scene" | "transcript" | "shots" | "assistant" | "audio" | "export" | "project";

export function Editor({ projectId }: { projectId: string }) {
  const p = useProject(projectId);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("scene");
  const [reviewHidden, setReviewHidden] = useState(false);
  const previewRef = useRef<PreviewHandle>(null);
  const [clock, setClock] = useState<PreviewClock>({ time: 0, playing: false, ready: false });
  const onClock = useCallback((c: PreviewClock) => setClock(c), []);
  const [claudeStatus] = useClaudeStatus();
  useEffect(() => {
    if (p.doc && (!selected || !p.doc.scenes.some((s) => s.id === selected))) setSelected(p.doc.scenes[0]?.id ?? null);
  }, [p.doc, selected]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void p.undoRedo(e.shiftKey ? "redo" : "undo");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);
  // Open the Script tab once when a script is being written or waits for approval.
  const scriptOpened = useRef(false);
  useEffect(() => {
    if (scriptOpened.current || !p.doc || !p.view) return;
    const writing = p.view.jobs.some((j) => j.type === "write_script" && ["queued", "running"].includes(j.status));
    if (writing || p.doc.script?.status === "draft") {
      scriptOpened.current = true;
      setTab("script");
    }
  }, [p.doc, p.view]);
  const blocking = useMemo(() => (p.doc ? validateTimeline(p.doc).filter((i) => i.severity === "error").map((i) => i.message) : []), [p.doc]);

  if (p.loadError && !p.doc) return <main className="p-8 text-bad">{p.loadError}</main>;
  if (!p.doc || !p.view || !p.revisionId) return <main className="p-8 text-dim">Loading project…</main>;
  const { doc, view } = p;
  const scene = doc.scenes.find((s) => s.id === selected) ?? doc.scenes[0]!;
  const paused = view.jobs.find((j) => (j.type === "plan" || j.type === "assistant") && j.status === "paused");
  const flow = projectFlow({ doc, jobs: view.jobs, exports: view.exports, revisionId: p.revisionId, blocking });
  const onFlow = (a: FlowAction) => {
    if (a.kind === "review") return setReviewHidden(false);
    if (a.kind !== "tab") return;
    setReviewHidden(true);
    setTab(a.tab === "script" && (doc.program || doc.template.family === "music-video") ? "scene" : a.tab === "shots" && !doc.scenes.some((s) => s.shot) ? "scene" : a.tab);
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <Link href="/projects" className="btn btn-ghost gap-1 px-2 text-xs" aria-label="Back to projects">
          ← <LogoMark size={16} />
        </Link>
        <div className="w-56 sm:w-72">
          <DebouncedText ariaLabel="Project title" value={doc.title} maxLength={160} onCommit={(v) => v.trim() && p.apply([{ op: "setTitle", title: v.trim() }])} />
        </div>
        {view.project.isSample && <span className="sample-badge" title="Fictional product and generated assets">Sample project</span>}
        <SaveIndicator save={p.save} onReload={() => p.refresh({ force: true })} />
        <div className="ml-auto flex items-center gap-1">
          <button className="btn btn-ghost text-xs" disabled={!p.history.canUndo} onClick={() => p.undoRedo("undo")} title="Undo (⌘Z)">Undo</button>
          <button className="btn btn-ghost text-xs" disabled={!p.history.canRedo} onClick={() => p.undoRedo("redo")} title="Redo (⇧⌘Z)">Redo</button>
          <span className="chip">{doc.format.aspect}</span>
          <span className="chip">r{view.revision.seq}</span>
        </div>
      </header>
      {p.notice && (
        <div role="status" className="flex items-center gap-2 border-b border-line bg-accent/10 px-3 py-1 text-xs">
          {p.notice}
          <button className="ml-auto underline" onClick={p.clearNotice}>Dismiss</button>
        </div>
      )}
      <FlowBar flow={flow} projectId={projectId} revisionId={p.revisionId} onAction={onFlow} />
      {paused && (
        <div role="status" className="flex items-center gap-2 border-b border-line bg-panel-2 px-3 py-1 text-xs">
          <span className="text-warn">Claude paused:</span> {paused.error?.message}
          <button className="ml-auto underline" onClick={() => setTab("assistant")}>Resume or cancel in the Assistant tab</button>
        </div>
      )}
      <p className="border-b border-line bg-panel-2 px-3 py-1 text-[11px] text-dim lg:hidden">
        Small screen: review, text edits, rendering and downloads work here. Timeline editing is designed for tablet and desktop.
      </p>
      {doc.review?.status === "pending" && !reviewHidden ? (
        <ShotPlanReview
          projectId={projectId}
          doc={doc}
          view={view}
          apply={p.apply}
          revRef={p.revRef}
          revisionId={p.revisionId}
          refresh={() => p.refresh()}
          claudeReady={!!claudeStatus?.readiness.available}
          onOpenScene={(id) => {
            setSelected(id);
            setTab("scene");
            setReviewHidden(true);
          }}
          onDismiss={() => setReviewHidden(true)}
        />
      ) : (
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[216px_minmax(0,1fr)_368px] lg:grid-rows-[minmax(0,1fr)_auto] lg:overflow-hidden">
        <aside className="order-4 min-h-0 border-line p-2.5 lg:order-none lg:col-start-1 lg:row-start-1 lg:overflow-y-auto lg:border-r">
          <SceneList doc={doc} view={view} selected={scene.id} onSelect={(id) => { setSelected(id); setTab("scene"); }} apply={p.apply} />
        </aside>
        <main className="order-1 flex min-h-[360px] flex-col p-3 lg:order-none lg:col-start-2 lg:row-start-1 lg:min-h-0">
          <Preview ref={previewRef} projectId={projectId} doc={doc} revisionId={p.revisionId} exports={view.exports} jobs={view.jobs} blockingIssues={blocking} onClock={onClock} />
        </main>
        <div className="order-2 min-w-0 border-line p-2 lg:order-none lg:col-span-2 lg:col-start-1 lg:row-start-2 lg:max-h-[40vh] lg:overflow-y-auto lg:border-t">
          <Timeline
            doc={doc}
            view={view}
            time={clock.time}
            playing={clock.playing}
            onSeek={(sec, m) => previewRef.current?.seek(sec, m)}
            selectedSceneId={scene.id}
            onSelectScene={(id) => { setSelected(id); setTab("scene"); }}
            apply={p.apply}
          />
        </div>
        <aside className="order-3 flex min-h-0 flex-col border-line bg-panel/40 lg:order-none lg:col-start-3 lg:row-span-2 lg:row-start-1 lg:border-l">
          <div role="tablist" aria-label="Inspector" className="flex gap-0.5 overflow-x-auto border-b border-line px-2 py-1.5">
            {([...(doc.program ? ["transcript"] : []), ...(!doc.program && doc.template.family !== "music-video" ? ["script"] : []), "scene", ...(doc.scenes.some((s) => s.shot) ? ["shots"] : []), "assistant", "critic", "audio", "export", "project"] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`seg shrink-0 capitalize ${tab === t ? "seg-on" : ""}`} onClick={() => setTab(t)}>
                {t === "assistant" ? "Assistant" : t}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3" role="tabpanel">
            {tab === "transcript" && doc.program && <ProgramPanel projectId={projectId} doc={doc} view={view} apply={p.apply} onChanged={() => p.refresh()} />}
            {tab === "shots" && <ShotsPanel projectId={projectId} doc={doc} jobs={view.jobs} apply={p.apply} />}
            {tab === "script" && <ScriptPanel projectId={projectId} doc={doc} jobs={view.jobs} apply={p.apply} revRef={p.revRef} revisionId={p.revisionId} refresh={() => p.refresh()} claudeReady={!!claudeStatus?.readiness.available} />}
            {tab === "critic" && (
              <CriticPanel
                projectId={projectId}
                doc={doc}
                revisionId={p.revisionId}
                jobs={view.jobs}
                revRef={p.revRef}
                claudeReady={!!claudeStatus?.readiness.available}
                onJump={(sceneId, t) => {
                  setSelected(sceneId);
                  previewRef.current?.seek(t);
                }}
              />
            )}
            {tab === "scene" && <SceneInspector projectId={projectId} doc={doc} scene={scene} apply={p.apply} />}
            {tab === "assistant" && <AssistantPanel projectId={projectId} doc={doc} revisionId={p.revisionId} selected={scene.id} jobs={view.jobs} claude={claudeStatus?.readiness ?? null} />}
            {tab === "audio" && <AudioPanel projectId={projectId} doc={doc} apply={p.apply} jobs={view.jobs} />}
            {tab === "export" && (
              <div className="space-y-6">
                <QualityPanel projectId={projectId} revisionId={p.revisionId} jobs={view.jobs} blocking={blocking.length > 0} loop={doc.loop} onLoop={(loop) => p.apply([{ op: "setLoop", loop }])} />
                <ExportPanel projectId={projectId} doc={doc} revisionId={p.revisionId} exports={view.exports} jobs={view.jobs} blocking={blocking.length > 0} />
                <LanternistPanel projectId={projectId} jobs={view.jobs} />
              </div>
            )}
            {tab === "project" && <ProjectPanel doc={doc} view={view} apply={p.apply} />}
          </div>
        </aside>
      </div>
      )}
    </div>
  );
}

function SaveIndicator({ save, onReload }: { save: ReturnType<typeof useProject>["save"]; onReload: () => void }) {
  const text = save.kind === "saved" ? "Saved" : save.kind === "saving" ? "Saving…" : save.kind === "conflict" ? "Not saved — conflict" : "Save failed";
  const color = save.kind === "saved" ? "text-ok" : save.kind === "saving" ? "text-dim" : "text-bad";
  return (
    <span className="flex items-center gap-2 text-xs" aria-live="polite">
      <span className={color} data-testid="save-state">{text}</span>
      {(save.kind === "error" || save.kind === "conflict") && (
        <>
          <span className="max-w-72 truncate text-dim" title={save.message}>{save.message}</span>
          <button className="btn px-2 py-0.5 text-xs" onClick={onReload}>Reload latest</button>
        </>
      )}
    </span>
  );
}
