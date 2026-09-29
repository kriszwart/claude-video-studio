"use client";
import { LAYOUTS } from "@vs/compositor";
import { secondsToFrames, type Background, type Layer, type Operation, type ProjectDocument, type Scene } from "@vs/domain";
import { useEffect, useState } from "react";
import { AssetPicker } from "@/components/AssetPicker";
import { api, fmtDuration } from "@/lib/client/api";
import { ColorField, DebouncedText, NumberField } from "./fields";

const TRANSITIONS = ["cut", "fade", "slide", "wipe", "zoom"] as const;
const FRAMES = ["none", "card", "laptop", "phone", "circle", "rounded"] as const;
const ENTRANCES = ["none", "fade", "rise", "pop", "slide", "type", "wipe", "draw"] as const;

export function SceneInspector({ doc, scene, apply }: { doc: ProjectDocument; scene: Scene; apply: (ops: Operation[]) => Promise<boolean> }) {
  const fps = doc.format.fps;
  const locked = scene.locked;
  const colors = doc.brand.colors as Record<string, string>;
  const op = (o: Operation) => apply([o]);
  const index = doc.scenes.findIndex((s) => s.id === scene.id);
  const slots = Object.keys(LAYOUTS[scene.layout]?.[doc.format.aspect] ?? {});
  const missingSlots = scene.layers.filter((l) => !l.box && !slots.includes(l.slot)).map((l) => l.slot);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-medium">
            Scene {index + 1}: {scene.purpose}
          </h3>
          <p className="text-xs text-faint">Recipe step: {scene.recipeSlot}</p>
        </div>
        <button className="btn btn-ghost shrink-0 px-2 py-1 text-xs" disabled={locked} title="Re-roll background, props and pose (code-generated; text, media and the character's identity are kept)" onClick={() => op({ op: "varyScene", sceneId: scene.id, variant: Math.floor(Date.now() % 1_000_000) + 1 })}>
          New variation
        </button>
        <label className="flex shrink-0 items-center gap-1.5 text-xs">
          <input type="checkbox" checked={locked} onChange={(e) => op({ op: "setSceneLock", sceneId: scene.id, locked: e.target.checked })} />
          Locked
        </label>
      </div>
      <p className="rounded-md border border-line bg-bg p-2 text-[11px] leading-relaxed text-dim">
        {locked
          ? "This scene is locked: the assistant, the planner and bulk edits can't change its content, and you need to unlock it to edit. Its start time can still move when earlier scenes change length (ripple)."
          : "Lock a scene to protect its content from the assistant, re-planning and bulk edits. Ripple timing from earlier scenes can still move its position."}
      </p>

      {scene.quote && <QuoteSource quote={scene.quote} />}

      <fieldset disabled={locked} className="space-y-3 disabled:opacity-60">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="purpose">Purpose</label>
            <DebouncedText id="purpose" value={scene.purpose} maxLength={80} onCommit={(v) => op({ op: "setSceneMeta", sceneId: scene.id, purpose: v || scene.purpose })} />
          </div>
          <div>
            <label className="label" htmlFor="dur">Duration</label>
            <NumberField id="dur" value={scene.durationFrames / fps} min={0.5} max={120} suffix="s" onCommit={(v) => op({ op: "setSceneDuration", sceneId: scene.id, durationFrames: Math.max(15, secondsToFrames(v, fps)) })} />
          </div>
          <div>
            <label className="label" htmlFor="trans">Transition in</label>
            <select id="trans" className="input" value={scene.transitionIn.type} disabled={index === 0} onChange={(e) => op({ op: "setSceneTransition", sceneId: scene.id, transition: { type: e.target.value as Scene["transitionIn"]["type"], durationFrames: e.target.value === "cut" ? 0 : Math.max(6, scene.transitionIn.durationFrames || 12) } })}>
              {TRANSITIONS.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="tdur">Transition length</label>
            <NumberField id="tdur" value={scene.transitionIn.durationFrames / fps} step={0.05} min={0} max={2} suffix="s" disabled={index === 0 || scene.transitionIn.type === "cut"} onCommit={(v) => op({ op: "setSceneTransition", sceneId: scene.id, transition: { ...scene.transitionIn, durationFrames: secondsToFrames(v, fps) } })} />
          </div>
          <div>
            <label className="label" htmlFor="layout">Layout</label>
            <select id="layout" className="input" value={scene.layout} onChange={(e) => op({ op: "setSceneLayout", sceneId: scene.id, layout: e.target.value })}>
              {Object.keys(LAYOUTS).map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="motion">Motion intensity: {Math.round(scene.motionIntensity * 100)}%</label>
            <input id="motion" type="range" min={0} max={1} step={0.05} className="w-full" defaultValue={scene.motionIntensity} key={scene.id + scene.motionIntensity} onMouseUp={(e) => op({ op: "setSceneMotion", sceneId: scene.id, motionIntensity: Number((e.target as HTMLInputElement).value) })} onKeyUp={(e) => op({ op: "setSceneMotion", sceneId: scene.id, motionIntensity: Number((e.target as HTMLInputElement).value) })} />
          </div>
        </div>
        {missingSlots.length > 0 && <p className="text-xs text-warn">Layout “{scene.layout}” has no position for: {missingSlots.join(", ")}. Those layers use a default box.</p>}
        <BackgroundEditor bg={scene.background} colors={colors} onChange={(background) => op({ op: "setSceneBackground", sceneId: scene.id, background })} />
        <div>
          <label className="label" htmlFor="narr">Narration script (optional)</label>
          <DebouncedText id="narr" multiline value={scene.script.narration} maxLength={1200} onCommit={(v) => op({ op: "setSceneScript", sceneId: scene.id, narration: v })} placeholder="Voiceover for this scene" />
        </div>
      </fieldset>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-dim">Layers</h4>
        <ul className="space-y-2">
          {scene.layers.map((l) => (
            <li key={l.id}>
              <fieldset disabled={locked} className="card space-y-2 p-2.5 disabled:opacity-60">
                <LayerEditor layer={l} scene={scene} doc={doc} apply={apply} colors={colors} />
              </fieldset>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function BackgroundEditor({ bg, colors, onChange }: { bg: Background; colors: Record<string, string>; onChange: (b: Background) => void }) {
  return (
    <div>
      <label className="label" htmlFor="bgtype">Background</label>
      <div className="space-y-2">
        <select
          id="bgtype"
          className="input"
          value={bg.type}
          onChange={(e) => {
            const t = e.target.value;
            if (t === "color") onChange({ type: "color", color: bg.type === "gradient" ? bg.from : "brand.background" });
            if (t === "gradient") onChange({ type: "gradient", from: bg.type === "color" ? bg.color : "brand.background", to: "brand.secondary", angle: 135 });
          }}
        >
          <option value="color">Solid colour</option>
          <option value="gradient">Gradient</option>
          {bg.type === "asset" && <option value="asset">Image</option>}
        </select>
        {bg.type === "color" && <ColorField value={bg.color} brandColors={colors} onChange={(c) => onChange({ type: "color", color: c ?? "brand.background" })} />}
        {bg.type === "gradient" && (
          <>
            <ColorField value={bg.from} brandColors={colors} onChange={(c) => onChange({ ...bg, from: c ?? "brand.background" })} />
            <ColorField value={bg.to} brandColors={colors} onChange={(c) => onChange({ ...bg, to: c ?? "brand.secondary" })} />
          </>
        )}
      </div>
    </div>
  );
}

function LayerEditor({ layer, scene, doc, apply, colors }: { layer: Layer; scene: Scene; doc: ProjectDocument; apply: (ops: Operation[]) => Promise<boolean>; colors: Record<string, string> }) {
  const base = { sceneId: scene.id, layerId: layer.id };
  const header = (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-medium capitalize">{layer.kind === "text" ? layer.role : layer.kind}</span>
      <span className="text-faint">in {layer.slot}</span>
      <label className="ml-auto flex items-center gap-1 text-faint">
        <input type="checkbox" checked={!layer.hidden} onChange={(e) => apply([{ op: "setLayerHidden", ...base, hidden: !e.target.checked }])} />
        visible
      </label>
    </div>
  );
  switch (layer.kind) {
    case "text": {
      const fact = layer.approvedFactId ? doc.brief.approvedFacts.find((f) => f.id === layer.approvedFactId) : undefined;
      return (
        <>
          {header}
          {fact && <p className="text-[11px] text-ok">Approved claim — the assistant cannot reword it.</p>}
          <DebouncedText ariaLabel={`${layer.role} text`} multiline={layer.text.length > 40} value={layer.text} maxLength={600} onCommit={(v) => apply([{ op: "updateLayerText", ...base, text: v }])} />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Size ×{layer.style.scale.toFixed(2)}</label>
              <input type="range" min={0.5} max={2} step={0.05} className="w-full" defaultValue={layer.style.scale} key={layer.id + layer.style.scale} onMouseUp={(e) => apply([{ op: "setLayerStyle", ...base, style: { scale: Number((e.target as HTMLInputElement).value) } }])} onKeyUp={(e) => apply([{ op: "setLayerStyle", ...base, style: { scale: Number((e.target as HTMLInputElement).value) } }])} aria-label="Text size" />
            </div>
            <div>
              <label className="label">Backing</label>
              <select className="input" value={layer.style.backing} onChange={(e) => apply([{ op: "setLayerStyle", ...base, style: { backing: e.target.value as "none" } }])}>
                <option value="none">None</option>
                <option value="solid">Solid (most readable)</option>
                <option value="translucent">Translucent</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="label">Colour</label>
              <ColorField allowUnset value={layer.style.color} brandColors={colors} onChange={(c) => apply([{ op: "setLayerStyle", ...base, style: { color: c } }])} />
            </div>
            <div>
              <label className="label">Entrance</label>
              <select className="input" value={layer.animation.in} onChange={(e) => apply([{ op: "setLayerAnimation", ...base, animation: { in: e.target.value } }])}>
                {ENTRANCES.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Delay</label>
              <NumberField value={layer.animation.delayFrames / 30} min={0} max={scene.durationFrames / 30 - 0.1} suffix="s" onCommit={(v) => apply([{ op: "setLayerAnimation", ...base, animation: { delayFrames: Math.round(v * 30) } }])} />
            </div>
          </div>
        </>
      );
    }
    case "image":
    case "video":
      return (
        <>
          {header}
          <AssetPicker kind={layer.kind} value={layer.assetId ? [layer.assetId] : []} onChange={(ids) => apply([{ op: "replaceSceneAsset", ...base, assetId: ids[0] ?? null }])} />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Fit</label>
              <select className="input" value={layer.fit} onChange={(e) => apply([{ op: "setLayerMedia", ...base, fit: e.target.value as "cover" }])}>
                <option value="contain">Fit (no crop)</option>
                <option value="cover">Fill (crop)</option>
              </select>
            </div>
            <div>
              <label className="label">Frame</label>
              <select className="input" value={layer.frame} onChange={(e) => apply([{ op: "setLayerMedia", ...base, frame: e.target.value as "none" }])}>
                {FRAMES.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="label">Focal point (for cropping): {Math.round(layer.focal.x * 100)}% × {Math.round(layer.focal.y * 100)}%</label>
              <div className="flex gap-2">
                <input type="range" aria-label="Focal X" min={0} max={1} step={0.05} className="w-full" defaultValue={layer.focal.x} key={`fx${layer.focal.x}`} onMouseUp={(e) => apply([{ op: "setLayerMedia", ...base, focal: { x: Number((e.target as HTMLInputElement).value), y: layer.focal.y } }])} />
                <input type="range" aria-label="Focal Y" min={0} max={1} step={0.05} className="w-full" defaultValue={layer.focal.y} key={`fy${layer.focal.y}`} onMouseUp={(e) => apply([{ op: "setLayerMedia", ...base, focal: { x: layer.focal.x, y: Number((e.target as HTMLInputElement).value) } }])} />
              </div>
            </div>
            {layer.kind === "video" && (
              <label className="col-span-2 flex items-center gap-2 text-xs">
                <input type="checkbox" checked={!layer.muted} onChange={(e) => apply([{ op: "setLayerMedia", ...base, muted: !e.target.checked }])} />
                Include this clip’s own audio
              </label>
            )}
          </div>
        </>
      );
    case "shape":
      return (
        <>
          {header}
          <ColorField value={layer.color} brandColors={colors} onChange={(c) => c && apply([{ op: "setShapeColor", ...base, color: c }])} />
          <p className="text-[11px] text-faint">Decorative {layer.shape}.</p>
        </>
      );
    case "character": {
      const ch = doc.characters.find((c) => c.id === layer.characterId);
      const sel = (label: string, key: "pose" | "accessory" | "facing", options: string[]) => (
        <div>
          <label className="label">{label}</label>
          <select className="input" value={layer[key]} onChange={(e) => apply([{ op: "setCharacterPose", ...base, [key]: e.target.value } as Operation])}>
            {options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
      );
      return (
        <>
          {header}
          <p className="text-[11px] text-dim">
            {ch ? `${ch.name} — ${ch.mode === "image" ? "your cutout" : `vector ${ch.species}`}${ch.locked ? " (reference locked)" : ""}` : "Missing character"}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {sel("Pose", "pose", ["idle", "wave", "jump", "think", "celebrate", "point", "walk"])}
            {sel("Costume", "accessory", ["none", "hat", "cape", "glasses", "crown", "helmet"])}
            {sel("Facing", "facing", ["right", "left"])}
            <div>
              <label className="label">Size</label>
              <NumberField value={layer.scale} step={0.05} min={0.2} max={3} onCommit={(v) => apply([{ op: "setCharacterPose", ...base, scale: v }])} />
            </div>
          </div>
        </>
      );
    }
    case "graphics":
      return (
        <>
          {header}
          <p className="text-[11px] text-dim">
            {layer.backend === "redraw" ? "Redraw" : "Skia"} component “{layer.component}” v{layer.componentVersion}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(layer.params).map(([k, v]) => (
              <div key={k}>
                <label className="label">{k}</label>
                {typeof v === "number" ? (
                  <NumberField value={v} step={0.05} onCommit={(n) => apply([{ op: "setGraphicsParams", ...base, params: { [k]: n } }])} />
                ) : typeof v === "boolean" ? (
                  <input type="checkbox" checked={v} onChange={(e) => apply([{ op: "setGraphicsParams", ...base, params: { [k]: e.target.checked } }])} />
                ) : (
                  <DebouncedText value={v} onCommit={(s) => apply([{ op: "setGraphicsParams", ...base, params: { [k]: s } }])} />
                )}
              </div>
            ))}
          </div>
        </>
      );
  }
}

/** Where an event quote comes from: verbatim text, exact source range and a playable excerpt (A19). */
function QuoteSource({ quote }: { quote: NonNullable<Scene["quote"]> }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    api<{ asset: { url: string | null } }>(`/api/assets/${quote.assetId}`).then((r) => setUrl(r.asset.url)).catch(() => setUrl(null));
  }, [quote.assetId]);
  return (
    <section className="rounded-md border border-line bg-bg p-2 text-xs" aria-label="Quote source" data-testid="quote-source">
      <p className="mb-1 font-medium">Authentic quote (from the recording; not editable by the assistant)</p>
      <p className="mb-1">“{quote.text}”</p>
      <p className="text-faint">
        {quote.sourceName} · words {fmtDuration(quote.speechInSec)}–{fmtDuration(quote.speechOutSec)} · clip {fmtDuration(quote.clipInSec)}–{fmtDuration(quote.clipOutSec)}
        {quote.cutLevelsDb.in !== null && ` · cut levels ${quote.cutLevelsDb.in?.toFixed(0)} / ${quote.cutLevelsDb.out?.toFixed(0)} dBFS`}
      </p>
      {url && <video className="mt-1 max-h-32 rounded" controls preload="none" src={`${url}#t=${quote.clipInSec.toFixed(2)},${quote.clipOutSec.toFixed(2)}`} aria-label="Play the original source range" />}
    </section>
  );
}
