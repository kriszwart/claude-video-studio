"use client";
import type { Operation, ProjectDocument, Scene } from "@vs/domain";
import { newClientId } from "./ids";
import type { ProjectViewDTO } from "./types";

export function SceneList({ doc, view, selected, onSelect, apply }: { doc: ProjectDocument; view: ProjectViewDTO; selected: string | null; onSelect: (id: string) => void; apply: (ops: Operation[]) => Promise<boolean> }) {
  return (
    <nav aria-label="Scenes" className="flex min-h-0 flex-col">
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="panel-title">Scenes · {doc.scenes.length}</h2>
      </div>
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {doc.scenes.map((s, i) => (
          <SceneItem key={s.id} scene={s} index={i} count={doc.scenes.length} kf={view.keyframes[s.id]} selected={selected === s.id} onSelect={() => onSelect(s.id)} apply={apply} aspect={doc.format.aspect} fps={doc.format.fps} />
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

function SceneItem({ scene, index, count, kf, selected, onSelect, apply, aspect, fps }: { scene: Scene; index: number; count: number; kf?: { url: string; fresh: boolean }; selected: boolean; onSelect: () => void; apply: (ops: Operation[]) => Promise<boolean>; aspect: string; fps: number }) {
  const [aw, ah] = aspect.split(":").map(Number) as [number, number];
  return (
    <li className={`group rounded-lg border p-1.5 transition-colors ${selected ? "border-accent/70 bg-accent/10" : "border-transparent hover:border-line hover:bg-panel"}`}>
      <button onClick={onSelect} className="block w-full text-left" aria-current={selected ? "true" : undefined}>
        <div className="relative flex h-24 items-center justify-center overflow-hidden rounded-md bg-black/60">
          {kf ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={kf.url} alt={`Keyframe of scene ${index + 1}`} className={`h-full object-cover ${kf.fresh ? "" : "opacity-40"}`} style={{ aspectRatio: `${aw} / ${ah}` }} />
          ) : (
            <span className="text-[10px] text-faint">rendering frame…</span>
          )}
          <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 text-[10px] font-semibold tabular-nums text-white">{index + 1}</span>
          {kf && !kf.fresh && <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 text-[9px] text-warn">updating</span>}
          {scene.locked && <span className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 text-[9px] text-white">locked</span>}
        </div>
        <div className="mt-1.5 px-0.5">
          <div className="truncate text-xs font-medium text-ink">{scene.purpose}</div>
          <div className="truncate text-[11px] text-faint">
            {(scene.durationFrames / fps).toFixed(1)}s · {scene.layout}
            {scene.status.state === "needs_input" && <span className="text-warn"> · needs media</span>}
          </div>
        </div>
      </button>
      {selected && (
        <div className="mt-1.5 flex flex-wrap items-center gap-0.5">
          <button className="btn btn-icon h-7 w-7 text-xs" disabled={index === 0} onClick={() => apply([{ op: "moveScene", sceneId: scene.id, toIndex: index - 1 }])} aria-label="Move scene up" title="Move up">↑</button>
          <button className="btn btn-icon h-7 w-7 text-xs" disabled={index === count - 1} onClick={() => apply([{ op: "moveScene", sceneId: scene.id, toIndex: index + 1 }])} aria-label="Move scene down" title="Move down">↓</button>
          <button className="btn btn-ghost px-2 py-0.5 text-[11px]" onClick={() => apply([{ op: "setSceneLock", sceneId: scene.id, locked: !scene.locked }])}>{scene.locked ? "Unlock" : "Lock"}</button>
          <button className="btn btn-ghost ml-auto px-2 py-0.5 text-[11px] text-bad" disabled={count <= 1 || scene.locked} onClick={() => confirm(`Delete scene "${scene.purpose}"? You can undo this.`) && apply([{ op: "deleteScene", sceneId: scene.id }])}>Delete</button>
        </div>
      )}
    </li>
  );
}
