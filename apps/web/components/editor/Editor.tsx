"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { validateTimeline } from "@vs/domain";
import { api } from "@/lib/client/api";
import { useClaudeStatus } from "@/lib/client/claude";
import { AssistantPanel } from "./AssistantPanel";
import { AudioPanel } from "./AudioPanel";
import { ExportPanel } from "./ExportPanel";
import { QualityPanel } from "./QualityPanel";
import { DebouncedText } from "./fields";
import { Preview } from "./Preview";
import { ProgramPanel } from "./ProgramPanel";
import { ShotsPanel } from "./ShotsPanel";
import { ProjectPanel } from "./ProjectPanel";
import { SceneInspector } from "./SceneInspector";
import { SceneList } from "./SceneList";
import { useProject } from "./useProject";

type Tab = "scene" | "transcript" | "shots" | "assistant" | "audio" | "export" | "project";

export function Editor({ projectId }: { projectId: string }) {
  const p = useProject(projectId);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("scene");
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
  const blocking = useMemo(() => (p.doc ? validateTimeline(p.doc).filter((i) => i.severity === "error").map((i) => i.message) : []), [p.doc]);

  if (p.loadError && !p.doc) return <main className="p-8 text-bad">{p.loadError}</main>;
  if (!p.doc || !p.view || !p.revisionId) return <main className="p-8 text-dim">Loading project…</main>;
  const { doc, view } = p;
  const scene = doc.scenes.find((s) => s.id === selected) ?? doc.scenes[0]!;
  const planning = view.jobs.find((j) => j.type === "plan" && ["queued", "running"].includes(j.status));
  const paused = view.jobs.find((j) => (j.type === "plan" || j.type === "assistant") && j.status === "paused");

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <Link href="/projects" className="btn btn-ghost px-2 text-xs" aria-label="Back to projects">
          ←
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
      {planning && (
        <div role="status" className="border-b border-line bg-panel-2 px-3 py-1 text-xs">
          Claude is planning the storyboard ({planning.stage}). You can keep editing; a plan that arrives after newer edits is not applied over them.
        </div>
      )}
      {paused && (
        <div role="status" className="flex items-center gap-2 border-b border-line bg-panel-2 px-3 py-1 text-xs">
          <span className="text-warn">Claude paused:</span> {paused.error?.message}
          <button className="ml-auto underline" onClick={() => setTab("assistant")}>Resume or cancel in the Assistant tab</button>
        </div>
      )}
      <p className="border-b border-line bg-panel-2 px-3 py-1 text-[11px] text-dim lg:hidden">
        Small screen: review, text edits, rendering and downloads work here. Timeline editing is designed for tablet and desktop.
      </p>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[250px_minmax(0,1fr)_380px] lg:overflow-hidden">
        <aside className="order-2 min-h-0 border-line p-3 lg:order-1 lg:overflow-y-auto lg:border-r">
          <SceneList doc={doc} view={view} selected={scene.id} onSelect={(id) => { setSelected(id); setTab("scene"); }} apply={p.apply} />
        </aside>
        <main className="order-1 min-h-0 p-3 lg:order-2 lg:overflow-y-auto">
          <Preview projectId={projectId} doc={doc} revisionId={p.revisionId} exports={view.exports} jobs={view.jobs} selectedSceneId={scene.id} onSelectScene={setSelected} blockingIssues={blocking} />
        </main>
        <aside className="order-3 flex min-h-0 flex-col border-line lg:border-l">
          <div role="tablist" aria-label="Inspector" className="flex gap-1 overflow-x-auto border-b border-line px-2 py-1.5">
            {([...(doc.program ? ["transcript"] : []), "scene", ...(doc.scenes.some((s) => s.shot) ? ["shots"] : []), "assistant", "audio", "export", "project"] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`btn btn-ghost shrink-0 px-2 py-1 text-xs capitalize ${tab === t ? "bg-panel-2 text-ink" : "text-dim"}`} onClick={() => setTab(t)}>
                {t === "assistant" ? "Assistant" : t}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3" role="tabpanel">
            {tab === "transcript" && doc.program && <ProgramPanel projectId={projectId} doc={doc} view={view} apply={p.apply} onChanged={() => p.refresh()} />}
            {tab === "shots" && <ShotsPanel projectId={projectId} doc={doc} jobs={view.jobs} apply={p.apply} />}
            {tab === "scene" && <SceneInspector doc={doc} scene={scene} apply={p.apply} />}
            {tab === "assistant" && <AssistantPanel projectId={projectId} doc={doc} revisionId={p.revisionId} selected={scene.id} jobs={view.jobs} claude={claudeStatus?.readiness ?? null} />}
            {tab === "audio" && <AudioPanel projectId={projectId} doc={doc} apply={p.apply} jobs={view.jobs} />}
            {tab === "export" && (
              <div className="space-y-6">
                <QualityPanel projectId={projectId} revisionId={p.revisionId} jobs={view.jobs} blocking={blocking.length > 0} />
                <ExportPanel projectId={projectId} doc={doc} revisionId={p.revisionId} exports={view.exports} jobs={view.jobs} blocking={blocking.length > 0} />
              </div>
            )}
            {tab === "project" && <ProjectPanel doc={doc} view={view} apply={p.apply} />}
          </div>
        </aside>
      </div>
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
