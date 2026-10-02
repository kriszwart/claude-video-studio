"use client";
import { useEffect, useState } from "react";
import { demoTail, spaceDemoSteps, type Operation, type ProjectDocument, type Scene } from "@vs/domain";
import { api, ApiError } from "@/lib/client/api";
import { DebouncedText, NumberField } from "./fields";
import type { JobDTO } from "./types";

type Demo = NonNullable<Scene["demo"]>;
type Step = Demo["steps"][number];

/**
 * Screen demo editor: click on the screenshot to add a step (where the cursor goes and the camera
 * zooms), adjust zoom, timing and action, or let Claude pick the steps from the screen itself.
 */
export function DemoEditor({ projectId, doc, scene, apply, jobs }: { projectId?: string; doc: ProjectDocument; scene: Scene; apply: (ops: Operation[]) => Promise<boolean>; jobs?: JobDTO[] }) {
  const fps = doc.format.fps;
  const images = scene.layers.filter((l) => (l.kind === "image" || l.kind === "video") && l.assetId && !l.hidden);
  const demo = scene.demo;
  const layer = demo ? scene.layers.find((l) => l.id === demo.layerId) : undefined;
  const assetId = layer && (layer.kind === "image" || layer.kind === "video") ? layer.assetId : null;
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const running = jobs?.find((j) => j.type === "plan_demo" && ["queued", "running"].includes(j.status));
  const lastPlan = jobs?.find((j) => j.type === "plan_demo");
  useEffect(() => {
    if (!assetId) return setUrl(null);
    api<{ asset: { url: string | null } }>(`/api/assets/${assetId}`).then((r) => setUrl(r.asset.url)).catch(() => setUrl(null));
  }, [assetId]);
  const save = (d: Demo | null) => apply([{ op: "setSceneDemo", sceneId: scene.id, demo: d ?? undefined }]);
  const setSteps = (steps: Step[]) => demo && save({ ...demo, steps: [...steps].sort((a, b) => a.atFrames - b.atFrames) });
  const respace = (steps: Step[]) => {
    const t = spaceDemoSteps(steps.length, scene.durationFrames, fps, demo?.zoomOut ?? true, demoTail(doc, scene.id));
    return steps.map((s, i) => ({ ...s, atFrames: t[i]! }));
  };

  if (!demo) {
    if (!images.length) return null;
    return (
      <section className="card space-y-2 p-2.5 text-xs" aria-label="Screen demo">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-dim">Screen demo</h4>
        <p className="text-faint">Turn a screenshot into a demo: a cursor works the real screen while the camera zooms to where it clicks.</p>
        <div className="flex flex-wrap gap-2">
          {images.map((l) => (
            <button key={l.id} className="btn" onClick={() => void save({ layerId: l.id, steps: [], zoomOut: true })}>
              Make “{l.slot}” a screen demo
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="card space-y-2 p-2.5 text-xs" aria-label="Screen demo" data-testid="demo-editor">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-dim">Screen demo</h4>
        <button className="btn btn-ghost ml-auto px-2 py-0.5 text-[11px]" onClick={() => void save(null)}>
          Stop being a demo
        </button>
      </div>
      <p className="text-faint">Click the screenshot where the cursor should go, in order. The camera zooms there (each doubling of zoom takes the same time, so it never lurches) and pulls back at the end.</p>
      {url ? (
        <div
          className="relative cursor-crosshair overflow-hidden rounded border border-line"
          data-testid="demo-screen"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
            const next = [...demo.steps, { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, zoom: 2, atFrames: 0, action: "click" as const, label: "" }];
            void setSteps(respace(next));
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="The demo's screenshot" className="block w-full" draggable={false} />
          {demo.steps.map((s, i) => (
            <span key={i} className="pointer-events-none absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white ring-2 ring-white" style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%` }}>
              {i + 1}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-faint">Loading the screenshot…</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {projectId && (
          <button
            className="btn"
            disabled={!!running || scene.locked}
            onClick={async () => {
              setErr(null);
              try {
                await api(`/api/projects/${projectId}/demo`, { method: "POST", idempotent: true, json: { sceneId: scene.id } });
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : String(e));
              }
            }}
          >
            {running ? `Planning… ${running.stage}` : demo.steps.length ? "Re-plan with Claude" : "Plan with Claude"}
          </button>
        )}
        {demo.steps.length > 1 && (
          <button className="btn btn-ghost" onClick={() => void setSteps(respace(demo.steps))}>
            Space steps evenly
          </button>
        )}
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={demo.zoomOut} onChange={(e) => void save({ ...demo, zoomOut: e.target.checked })} /> Pull back at the end
        </label>
      </div>
      {err && <p className="text-bad" role="alert">{err}</p>}
      {lastPlan?.status === "failed" && !running && <p className="text-bad">{lastPlan.error?.message} {lastPlan.error?.recovery}</p>}
      {demo.steps.length > 0 && (
        <ol className="space-y-1.5" data-testid="demo-steps">
          {demo.steps.map((s, i) => (
            <li key={i} className="grid grid-cols-[1.25rem_1fr_4.5rem_4.5rem_5rem_auto] items-center gap-1.5">
              <span className="font-bold text-blue-400">{i + 1}</span>
              <DebouncedText ariaLabel={`Step ${i + 1} label`} value={s.label} maxLength={80} placeholder="What's clicked" onCommit={(v) => void setSteps(demo.steps.map((x, k) => (k === i ? { ...x, label: v } : x)))} />
              <NumberField value={s.atFrames / fps} step={0.1} min={0} max={scene.durationFrames / fps - 0.1} suffix="s" onCommit={(v) => void setSteps(demo.steps.map((x, k) => (k === i ? { ...x, atFrames: Math.min(scene.durationFrames - 1, Math.round(v * fps)) } : x)))} />
              <NumberField value={s.zoom} step={0.25} min={1} max={4} suffix="×" onCommit={(v) => void setSteps(demo.steps.map((x, k) => (k === i ? { ...x, zoom: v } : x)))} />
              <select className="input py-0.5" aria-label={`Step ${i + 1} action`} value={s.action} onChange={(e) => void setSteps(demo.steps.map((x, k) => (k === i ? { ...x, action: e.target.value as Step["action"] } : x)))}>
                <option value="click">Click</option>
                <option value="move">Point</option>
              </select>
              <button className="btn btn-ghost px-1.5 py-0 text-[11px]" aria-label={`Remove step ${i + 1}`} onClick={() => void setSteps(respace(demo.steps.filter((_, k) => k !== i)))}>
                ✕
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
