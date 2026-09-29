"use client";
import type { Operation, ProjectDocument, Scene } from "@vs/domain";
import { newClientId } from "./ids";
import type { ProjectViewDTO } from "./types";

export function SceneList({ doc, view, selected, onSelect, apply }: { doc: ProjectDocument; view: ProjectViewDTO; selected: string | null; onSelect: (id: string) => void; apply: (ops: Operation[]) => Promise<boolean> }) {
  return (
    <nav aria-label="Scenes" className="flex min-h-0 flex-col">
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-dim">Scenes ({doc.scenes.length})</h2>
      </div>
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {doc.scenes.map((s, i) => (
          <SceneItem key={s.id} scene={s} index={i} count={doc.scenes.length} kf={view.keyframes[s.id]} selected={selected === s.id} onSelect={() => onSelect(s.id)} apply={apply} />
        ))}
      </ol>
      {selected && (
        <button className="btn mt-2 text-xs" onClick={() => apply([{ op: "duplicateScene", sceneId: selected, newSceneId: newClientId("scn") }])}>
          Duplicate selected scene
        </button>
      )}
    </nav>
  );
}

function SceneItem({ scene, index, count, kf, selected, onSelect, apply }: { scene: Scene; index: number; count: number; kf?: { url: string; fresh: boolean }; selected: boolean; onSelect: () => void; apply: (ops: Operation[]) => Promise<boolean> }) {
  return (
    <li className={`rounded-md border ${selected ? "border-accent bg-accent/10" : "border-line bg-panel"} p-1.5`}>
      <button onClick={onSelect} className="flex w-full gap-2 text-left" aria-current={selected ? "true" : undefined}>
        <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded bg-bg">
          {kf ? <img src={kf.url} alt={`Keyframe of scene ${index + 1}`} className={`h-full w-full object-cover ${kf.fresh ? "" : "opacity-40"}`} /> : <span className="absolute inset-0 flex items-center justify-center text-[10px] text-faint">rendering…</span>}
          {kf && !kf.fresh && <span className="absolute bottom-0 left-0 right-0 bg-black/70 text-center text-[9px] text-warn">updating</span>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">
            {index + 1}. {scene.purpose}
          </div>
          <div className="text-[11px] text-faint">
            {(scene.durationFrames / 30).toFixed(1)}s · {scene.layout}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {scene.locked && <span className="chip">🔒 locked</span>}
            {scene.status.state === "needs_input" && <span className="chip text-warn">needs media</span>}
          </div>
        </div>
      </button>
      {selected && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          <button className="btn btn-ghost px-2 py-0.5 text-[11px]" disabled={index === 0} onClick={() => apply([{ op: "moveScene", sceneId: scene.id, toIndex: index - 1 }])} aria-label="Move scene up">↑</button>
          <button className="btn btn-ghost px-2 py-0.5 text-[11px]" disabled={index === count - 1} onClick={() => apply([{ op: "moveScene", sceneId: scene.id, toIndex: index + 1 }])} aria-label="Move scene down">↓</button>
          <button className="btn btn-ghost px-2 py-0.5 text-[11px]" onClick={() => apply([{ op: "setSceneLock", sceneId: scene.id, locked: !scene.locked }])}>{scene.locked ? "Unlock" : "Lock"}</button>
          <button className="btn btn-ghost ml-auto px-2 py-0.5 text-[11px] text-bad" disabled={count <= 1 || scene.locked} onClick={() => confirm(`Delete scene "${scene.purpose}"? You can undo this.`) && apply([{ op: "deleteScene", sceneId: scene.id }])}>Delete</button>
        </div>
      )}
    </li>
  );
}
