"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { computeTimeline, resolveAudio, resolveCaptions, type Operation, type ProjectDocument } from "@vs/domain";
import type { ProjectViewDTO as ProjectView } from "./types";

const LABEL_W = 76;
const MIN_SCENE_SEC = 0.5;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * Multi-track timeline: scenes (with keyframes and transition overlaps), voice and music (with
 * waveforms of the part of the file actually used), captions and music markers, a ruler and a
 * draggable playhead that drives the preview. Drag a scene's right edge to change its length
 * (one typed edit on release; later scenes ripple).
 */
export function Timeline({
  doc,
  view,
  time,
  onSeek,
  selectedSceneId,
  onSelectScene,
  apply,
  playing,
}: {
  doc: ProjectDocument;
  view: ProjectView;
  time: number;
  onSeek: (sec: number, mode: "drag" | "commit") => void;
  selectedSceneId: string | null;
  onSelectScene: (id: string) => void;
  apply: (ops: Operation[]) => unknown;
  playing: boolean;
}) {
  const fps = doc.format.fps;
  const [trim, setTrim] = useState<{ sceneId: string; frames: number } | null>(null);
  // Preview the trim live on the timeline while dragging; the document changes on release.
  const shownDoc = useMemo(() => (trim ? { ...doc, scenes: doc.scenes.map((s) => (s.id === trim.sceneId ? { ...s, durationFrames: trim.frames } : s)) } : doc), [doc, trim]);
  const tl = useMemo(() => computeTimeline(shownDoc), [shownDoc]);
  const total = tl.totalFrames / fps;
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [zoom, setZoom] = useState<number | null>(null); // px per second; null = fit
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fitPps = Math.max(8, (width - LABEL_W - 16) / Math.max(1, total));
  const pps = zoom ?? fitPps;
  const x = (sec: number) => LABEL_W + sec * pps;
  const contentW = LABEL_W + total * pps + 16;

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing) return;
    const px = x(time);
    if (px < el.scrollLeft + LABEL_W || px > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, px - LABEL_W - 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, playing, pps]);

  const media = (id: string) => view.media?.[id]?.durationSec ?? undefined;
  const audio = useMemo(() => resolveAudio(shownDoc, tl, media), [shownDoc, tl]); // eslint-disable-line react-hooks/exhaustive-deps
  const voice = audio.filter((a) => a.track.kind === "voiceover" || a.track.kind === "source");
  const music = audio.filter((a) => a.track.kind === "music" || a.track.kind === "sfx");
  const cues = useMemo(() => (shownDoc.captions.enabled ? resolveCaptions(shownDoc, tl) : []), [shownDoc, tl]);
  const markers = shownDoc.markers ?? [];
  // Scene thumbnails keep the video's shape at clip height.
  const [aw, ah] = doc.format.aspect.split(":").map(Number) as [number, number];
  const thumbW = Math.round(50 * (aw / ah));

  // Ruler / playhead scrubbing.
  const scrubbing = useRef(false);
  const secAt = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(total, (clientX - r.left + el.scrollLeft - LABEL_W) / pps));
  };
  const onScrubDown = (e: React.PointerEvent) => {
    scrubbing.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    onSeek(secAt(e.clientX), "drag");
  };
  const onScrubMove = (e: React.PointerEvent) => scrubbing.current && onSeek(secAt(e.clientX), "drag");
  const onScrubUp = (e: React.PointerEvent) => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    onSeek(secAt(e.clientX), "commit");
  };

  // Scene trim by dragging the right edge.
  const trimStart = useRef<{ sceneId: string; x0: number; frames0: number } | null>(null);
  const onTrimDown = (e: React.PointerEvent, sceneId: string, frames: number) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    trimStart.current = { sceneId, x0: e.clientX, frames0: frames };
    setTrim({ sceneId, frames });
  };
  const onTrimMove = (e: React.PointerEvent) => {
    const t = trimStart.current;
    if (!t) return;
    const frames = Math.max(Math.round(MIN_SCENE_SEC * fps), Math.round(t.frames0 + ((e.clientX - t.x0) / pps) * fps));
    setTrim({ sceneId: t.sceneId, frames });
  };
  const onTrimUp = () => {
    const t = trimStart.current;
    trimStart.current = null;
    if (t && trim && trim.frames !== t.frames0) void apply([{ op: "setSceneDuration", sceneId: t.sceneId, durationFrames: trim.frames }]);
    setTrim(null);
  };
  // Keyboard trim: ←/→ ±0.1 s (Shift ±1 s), committed after a short pause.
  const kbTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onTrimKey = (e: React.KeyboardEvent, sceneId: string, frames: number) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = Math.round((e.shiftKey ? 1 : 0.1) * fps) * (e.key === "ArrowLeft" ? -1 : 1);
    const next = Math.max(Math.round(MIN_SCENE_SEC * fps), (trim?.sceneId === sceneId ? trim.frames : frames) + step);
    setTrim({ sceneId, frames: next });
    clearTimeout(kbTimer.current);
    kbTimer.current = setTimeout(() => {
      void apply([{ op: "setSceneDuration", sceneId, durationFrames: next }]);
      setTrim(null);
    }, 700);
  };

  // Ruler ticks sized to the zoom level.
  const step = pps > 120 ? 0.5 : pps > 50 ? 1 : pps > 20 ? 2 : pps > 8 ? 5 : 10;
  const ticks: number[] = [];
  for (let t = 0; t <= total + 1e-6; t += step) ticks.push(Number(t.toFixed(3)));

  const rows: { key: string; label: string; h: number }[] = [
    { key: "scenes", label: "Scenes", h: 52 },
    ...(voice.length ? [{ key: "voice", label: "Voice", h: 34 }] : []),
    ...(music.length ? [{ key: "music", label: "Music", h: 34 }] : []),
    ...(cues.length ? [{ key: "captions", label: "Captions", h: 24 }] : []),
    ...(markers.length ? [{ key: "markers", label: "Markers", h: 18 }] : []),
  ];
  const RULER = 22;
  const height = RULER + rows.reduce((a, r) => a + r.h + 4, 0) + 4;
  let y = RULER + 4;
  const rowY: Record<string, number> = {};
  for (const r of rows) {
    rowY[r.key] = y;
    y += r.h + 4;
  }

  return (
    <section aria-label="Timeline" className="rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-2 py-1 text-[11px] text-dim">
        <span className="font-medium text-ink">Timeline</span>
        <span className="font-mono">{fmt(time)} / {fmt(total)}</span>
        <span className="ml-auto" />
        <button className="btn btn-ghost px-1.5 py-0 text-xs" aria-label="Zoom out" onClick={() => setZoom(Math.max(4, (zoom ?? fitPps) / 1.5))}>−</button>
        <button className="btn btn-ghost px-1.5 py-0 text-xs" onClick={() => setZoom(null)} aria-pressed={zoom === null}>Fit</button>
        <button className="btn btn-ghost px-1.5 py-0 text-xs" aria-label="Zoom in" onClick={() => setZoom(Math.min(400, (zoom ?? fitPps) * 1.5))}>+</button>
      </div>
      <div ref={scroller} className="relative overflow-x-auto overflow-y-hidden" style={{ height }} data-testid="timeline">
        <div className="relative" style={{ width: contentW, height }} onPointerMove={(e) => (trimStart.current ? onTrimMove(e) : onScrubMove(e))} onPointerUp={(e) => (trimStart.current ? onTrimUp() : onScrubUp(e))}>
          {/* Ruler */}
          <div className="absolute left-0 right-0 top-0 cursor-ew-resize border-b border-line bg-panel-2" style={{ height: RULER }} onPointerDown={onScrubDown} role="slider" aria-label="Timeline position" aria-valuemin={0} aria-valuemax={Number(total.toFixed(2))} aria-valuenow={Number(time.toFixed(2))} tabIndex={-1}>
            {ticks.map((t) => (
              <div key={t} className="absolute top-0 h-full border-l border-line/70 pl-1 font-mono text-[10px] leading-[22px] text-faint" style={{ left: x(t) }}>
                {Number.isInteger(t) && (t % (step < 1 ? 1 : step) === 0) ? fmt(t) : ""}
              </div>
            ))}
          </div>
          {/* Row labels (sticky) */}
          {rows.map((r) => (
            <div key={r.key} className="sticky left-0 z-20 flex items-center bg-panel pl-2 text-[11px] text-faint" style={{ position: "absolute", top: rowY[r.key], height: r.h, width: LABEL_W - 6 }}>
              {r.label}
            </div>
          ))}

          {/* Scenes */}
          {tl.scenes.map((t, i) => {
            const s = shownDoc.scenes[i]!;
            const left = x(t.start / fps);
            const w = (t.duration / fps) * pps;
            const kf = view.keyframes[s.id];
            const sel = selectedSceneId === s.id;
            const overlap = (t.overlapIn ?? 0) / fps;
            return (
              <div key={s.id} className="absolute" style={{ left, width: w, top: rowY.scenes, height: 52 }}>
                <button
                  onClick={() => {
                    onSelectScene(s.id);
                    onSeek(t.start / fps + 0.01, "commit");
                  }}
                  className={`group relative flex h-full w-full items-stretch overflow-hidden rounded-md border text-left ${sel ? "border-accent bg-accent/15 ring-1 ring-accent" : "border-line bg-panel-2 hover:border-faint"}`}
                  aria-label={`Scene ${i + 1}: ${s.purpose}, ${(t.duration / fps).toFixed(1)} seconds`}
                  aria-pressed={sel}
                >
                  {overlap > 0 && <span className="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-accent/45 to-transparent" style={{ width: overlap * pps }} title={`${s.transitionIn.type} ${overlap.toFixed(2)}s`} />}
                  {kf && w > thumbW + 36 && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={kf.url} alt="" className={`h-full shrink-0 object-cover ${kf.fresh ? "" : "opacity-50"}`} style={{ width: thumbW }} />
                  )}
                  <span className="min-w-0 flex-1 py-1">
                    <span className="block truncate px-1.5 text-[11px] font-medium text-ink">{i + 1}. {s.purpose}</span>
                    <span className="block truncate px-1.5 text-[10px] text-faint">{(t.duration / fps).toFixed(1)}s{s.locked ? " · locked" : ""}{s.transitionIn.type !== "cut" && i > 0 ? ` · ${s.transitionIn.type}` : ""}</span>
                  </span>
                </button>
                {!s.locked && (
                  <div
                    role="slider"
                    tabIndex={0}
                    aria-label={`Length of scene ${i + 1}`}
                    aria-valuemin={MIN_SCENE_SEC}
                    aria-valuenow={Number((t.duration / fps).toFixed(2))}
                    aria-valuetext={`${(t.duration / fps).toFixed(1)} seconds`}
                    className="absolute -right-1 top-0 z-20 h-full w-2.5 cursor-ew-resize rounded-sm opacity-0 hover:bg-accent/80 hover:opacity-100 focus:bg-accent focus:opacity-100 group-hover:opacity-60"
                    onPointerDown={(e) => onTrimDown(e, s.id, s.durationFrames)}
                    onKeyDown={(e) => onTrimKey(e, s.id, s.durationFrames)}
                  />
                )}
              </div>
            );
          })}

          {/* Audio */}
          {(["voice", "music"] as const).map((row) =>
            (row === "voice" ? voice : music).map((a) => {
              const m = view.media?.[a.track.assetId];
              const left = x(a.startFrame / fps);
              const w = (a.durationFrames / fps) * pps;
              return (
                <div key={a.track.id} className={`absolute overflow-hidden rounded border ${row === "voice" ? "border-ok/40 bg-ok/10" : "border-accent/40 bg-accent/10"}`} style={{ left, width: w, top: rowY[row], height: 34 }} title={`${m?.name ?? a.track.kind} · ${(a.durationFrames / fps).toFixed(1)}s · ${a.track.gainDb} dB`}>
                  <Wave peaks={m?.peaks ?? null} mediaSec={m?.durationSec ?? null} fromSec={a.track.sourceInSec} lenSec={a.durationFrames / fps} width={w} height={34} className={row === "voice" ? "fill-ok/70" : "fill-accent/70"} />
                  <span className="absolute left-1 top-0.5 truncate rounded bg-black/50 px-1 text-[10px] text-ink/90" style={{ maxWidth: w - 6 }}>{m?.name ?? a.track.kind}</span>
                </div>
              );
            }),
          )}

          {/* Captions */}
          {cues.map((c) => (
            <div key={c.cue.id} className="absolute truncate rounded bg-panel-2 px-1 text-[10px] leading-[24px] text-dim" style={{ left: x(c.start / fps), width: Math.max(2, ((c.end - c.start) / fps) * pps - 1), top: rowY.captions, height: 24 }} title={c.cue.text}>
              {c.cue.text}
            </div>
          ))}

          {/* Markers */}
          {markers.map((mk) => (
            <div key={mk.id} className={`absolute w-px ${mk.kind === "section" ? "bg-warn" : mk.kind === "downbeat" ? "bg-ink/60" : "bg-ink/25"}`} style={{ left: x(mk.frame / fps), top: (rowY.markers ?? 0) + (mk.kind === "section" ? 0 : mk.kind === "downbeat" ? 5 : 9), height: mk.kind === "section" ? 18 : mk.kind === "downbeat" ? 13 : 9 }} title={`${mk.kind}${mk.label ? `: ${mk.label}` : ""}`} />
          ))}

          {/* Playhead */}
          <div className="pointer-events-none absolute top-0 z-30 w-px bg-accent" style={{ left: x(Math.min(time, total)), height }}>
            <div className="absolute -left-[5px] top-0 h-2.5 w-2.5 rotate-45 bg-accent" />
          </div>
        </div>
      </div>
    </section>
  );
}

/** Waveform of the slice [fromSec, fromSec + lenSec] of a file, from its ingest peaks. */
function Wave({ peaks, mediaSec, fromSec, lenSec, width, height, className }: { peaks: number[] | null; mediaSec: number | null; fromSec: number; lenSec: number; width: number; height: number; className: string }) {
  if (!peaks?.length || !mediaSec || width < 4) return null;
  const bars = Math.max(1, Math.min(Math.floor(width / 3), 600));
  const d: string[] = [];
  for (let i = 0; i < bars; i++) {
    const t = fromSec + (i / bars) * lenSec;
    const idx = Math.min(peaks.length - 1, Math.floor((t / mediaSec) * peaks.length));
    const v = Math.max(0.04, peaks[idx] ?? 0);
    const h = v * (height - 6);
    d.push(`M${((i / bars) * width).toFixed(1)} ${((height - h) / 2).toFixed(1)}h${Math.max(1, width / bars - 1).toFixed(1)}v${h.toFixed(1)}h-${Math.max(1, width / bars - 1).toFixed(1)}z`);
  }
  return (
    <svg className="absolute inset-0" width={width} height={height} aria-hidden="true">
      <path d={d.join("")} className={className} />
    </svg>
  );
}
