"use client";
import { countIssues, formatCount, parseCount, type CountSpec, type Operation, type ProjectDocument, type Scene, type TextLayer } from "@vs/domain";
import { NumberField } from "./fields";

/**
 * A counting number: the text counts through real values (e.g. a total counting down by each
 * row's real amount), each reached at its time. Values are checked against the approved facts.
 */
export function CountEditor({ doc, scene, layer, apply }: { doc: ProjectDocument; scene: Scene; layer: TextLayer; apply: (ops: Operation[]) => Promise<boolean> }) {
  const fps = doc.format.fps;
  const base = { sceneId: scene.id, layerId: layer.id };
  const set = (count: CountSpec | null) => apply([{ op: "setLayerCount", ...base, count }]);
  const parsed = parseCount(layer.text);
  const spec = layer.count;
  if (!spec) {
    if (!parsed) return null;
    return (
      <button
        className="btn btn-ghost px-2 py-0.5 text-[11px]"
        onClick={() => {
          const at = layer.animation.delayFrames;
          void set({ prefix: parsed.prefix, suffix: parsed.suffix, decimals: parsed.decimals, thousands: parsed.thousands, stops: [{ value: 0, atFrames: at }, { value: parsed.value, atFrames: Math.min(scene.durationFrames - 1, at + Math.round(fps)) }] });
        }}
      >
        Make this number count
      </button>
    );
  }
  const issues = countIssues(doc, scene.id, layer);
  const stops = spec.stops;
  const update = (i: number, patch: Partial<CountSpec["stops"][number]>) => void set({ ...spec, stops: stops.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  return (
    <div className="space-y-1.5 rounded border border-line p-2 text-xs" data-testid="count-editor">
      <div className="flex items-center gap-2">
        <span className="font-medium">Counting number</span>
        <span className="text-faint">{stops.map((s) => formatCount(s.value, spec)).join(" → ")}</span>
        <button className="btn btn-ghost ml-auto px-2 py-0.5 text-[11px]" onClick={() => void set(null)}>
          Stop counting
        </button>
      </div>
      <ol className="space-y-1">
        {stops.map((s, i) => (
          <li key={i} className="grid grid-cols-[1.5rem_1fr_5rem_auto] items-center gap-1.5">
            <span className="text-faint">{i + 1}</span>
            <NumberField value={s.value} step={1} onCommit={(v) => update(i, { value: v })} />
            <NumberField value={s.atFrames / fps} step={0.1} min={0} max={scene.durationFrames / fps - 0.05} suffix="s" onCommit={(v) => update(i, { atFrames: Math.min(scene.durationFrames - 1, Math.round(v * fps)) })} />
            <button className="btn btn-ghost px-1.5 py-0 text-[11px]" aria-label={`Remove stop ${i + 1}`} disabled={stops.length <= 2} onClick={() => void set({ ...spec, stops: stops.filter((_, k) => k !== i) })}>
              ✕
            </button>
          </li>
        ))}
      </ol>
      <button
        className="btn btn-ghost px-2 py-0.5 text-[11px]"
        disabled={stops.length >= 12 || stops.at(-1)!.atFrames + Math.round(fps * 0.5) >= scene.durationFrames}
        onClick={() => void set({ ...spec, stops: [...stops, { value: stops.at(-1)!.value, atFrames: Math.min(scene.durationFrames - 1, stops.at(-1)!.atFrames + Math.round(fps)) }] })}
      >
        + Add a stop
      </button>
      {issues.map((m) => (
        <p key={m} className="text-warn" role="status">
          {m}
        </p>
      ))}
    </div>
  );
}
