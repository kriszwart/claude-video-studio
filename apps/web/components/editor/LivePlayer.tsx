"use client";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api, ApiError, waitForJob } from "@/lib/client/api";

export interface LiveMeta {
  key: string;
  revisionId: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  scenes: { sceneId: string; startSec: number; durationSec: number }[];
}
export interface LivePlayerHandle {
  play(): void;
  pause(): void;
  toggle(): void;
  seek(sec: number, mode?: "drag" | "commit"): void;
}
export interface LiveState {
  time: number;
  playing: boolean;
  ready: boolean;
  building: boolean;
  meta: LiveMeta | null;
}

/** HyperFrames runtime protocol v1 metadata sent with every control message. */
const proto = (fps: number) => ({ protocolVersion: 1, capabilities: ["seconds-time", "rational-fps", "seek-keep-playing", "composition-manifest-v1", "runtime-data", "play-range"], fps: { numerator: Math.round(fps * 1000), denominator: 1000 } });

/**
 * Live preview: the revision's compiled composition playing in an iframe under the HyperFrames
 * runtime — the same page the exporter captures, so what you scrub is what renders. Edits
 * build a new bundle in the background; the current one keeps playing until the new one is
 * ready, then the player swaps at the same time position.
 */
export const LivePlayer = forwardRef<LivePlayerHandle, { projectId: string; revisionId: string; onState?: (s: LiveState) => void; muted?: boolean }>(function LivePlayer({ projectId, revisionId, onState, muted = false }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const frames = useRef<Record<string, HTMLIFrameElement | null>>({});
  const [shown, setShown] = useState<LiveMeta | null>(null);
  const [pending, setPending] = useState<LiveMeta | null>(null);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<{ message: string; recovery?: string } | null>(null);
  const [fit, setFit] = useState(1);
  const state = useRef<LiveState>({ time: 0, playing: false, ready: false, building: false, meta: null });
  const [, force] = useState(0);
  const emit = useCallback(() => {
    onState?.({ ...state.current });
    force((n) => n + 1);
  }, [onState]);

  const post = useCallback((key: string | undefined, action: string, extra: Record<string, unknown> = {}) => {
    const w = key ? frames.current[key]?.contentWindow : null;
    const meta = key === pending?.key ? pending : shown;
    if (w && meta) w.postMessage({ source: "hf-parent", type: "control", action, ...extra, ...proto(meta.fps) }, window.location.origin);
  }, [pending, shown]);

  useImperativeHandle(ref, () => ({
    play: () => post(shown?.key, "play"),
    pause: () => post(shown?.key, "pause"),
    toggle: () => post(shown?.key, state.current.playing ? "pause" : "play"),
    seek: (sec, mode = "commit") => {
      state.current.time = Math.max(0, Math.min(sec, shown?.durationSec ?? sec));
      post(shown?.key, "seek", { timeSeconds: state.current.time, seekMode: mode });
      emit();
    },
  }), [post, shown, emit]);

  // Build (or fetch the cached) bundle for each new revision, debounced while typing.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setBuilding(true);
      state.current.building = true;
      emit();
      try {
        const r = await api<{ job: { id: string; status: string; result: Record<string, unknown> | null; error: { code: string; message: string; recovery?: string } | null } }>(`/api/projects/${projectId}/live`, { method: "POST", json: { revisionId } });
        const done = r.job.status === "succeeded" ? r.job : await waitForJob(r.job.id, undefined, 10 * 60_000);
        if (cancelled) return;
        if (done.status !== "succeeded" || !done.result) throw new ApiError(422, done.error?.code ?? "failed", done.error?.message ?? "The live preview could not be built.", done.error?.recovery);
        const meta = done.result as unknown as LiveMeta;
        setError(null);
        if (!shown) setShown(meta);
        else if (meta.key !== shown.key) setPending(meta);
        else setBuilding(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiError ? { message: e.message, recovery: e.recovery } : { message: String(e) });
        setBuilding(false);
      } finally {
        if (!cancelled) {
          state.current.building = false;
          emit();
        }
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, revisionId]);

  // Runtime messages: readiness and playback state.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data as { source?: string; type?: string; currentTime?: number; isPlaying?: boolean };
      if (!d || d.source !== "hf-preview") return;
      const from = Object.entries(frames.current).find(([, f]) => f?.contentWindow === e.source)?.[0];
      if (!from) return;
      if (d.type === "ready") {
        const f = frames.current[from];
        f?.contentWindow?.postMessage({ source: "hf-parent", type: "control", action: "set-muted", muted, ...proto(30) }, window.location.origin);
        if (pending && from === pending.key) {
          // Swap in the new revision at the same time position (and keep playing if it was).
          const wasPlaying = state.current.playing;
          post(shown?.key, "pause");
          f?.contentWindow?.postMessage({ source: "hf-parent", type: "control", action: "seek", timeSeconds: Math.min(state.current.time, pending.durationSec), ...proto(pending.fps) }, window.location.origin);
          if (wasPlaying) f?.contentWindow?.postMessage({ source: "hf-parent", type: "control", action: "play", ...proto(pending.fps) }, window.location.origin);
          setShown(pending);
          setPending(null);
          setBuilding(false);
        } else if (shown && from === shown.key) {
          f?.contentWindow?.postMessage({ source: "hf-parent", type: "control", action: "seek", timeSeconds: state.current.time, ...proto(shown.fps) }, window.location.origin);
          setBuilding(false);
        }
        state.current.ready = true;
        emit();
      } else if (d.type === "state" && from === shown?.key) {
        state.current.time = d.currentTime ?? state.current.time;
        state.current.playing = !!d.isPlaying;
        emit();
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [pending, shown, post, emit, muted]);

  useEffect(() => {
    state.current.meta = shown;
    emit();
  }, [shown, emit]);
  useEffect(() => post(shown?.key, "set-muted", { muted }), [muted, shown, post]);

  // Fit the stage into the available box.
  useEffect(() => {
    const el = box.current;
    if (!el || !shown) return;
    const ro = new ResizeObserver(() => setFit(Math.min(el.clientWidth / shown.width, el.clientHeight / shown.height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown]);

  const src = (m: LiveMeta) => `/api/projects/${projectId}/live/${m.key}/index.html`;
  return (
    <div ref={box} className="relative h-full w-full overflow-hidden bg-black" data-testid="live-player">
      {[shown, pending].filter((m): m is LiveMeta => !!m).map((m) => (
        <iframe
          key={m.key}
          ref={(el) => {
            frames.current[m.key] = el;
          }}
          src={src(m)}
          title={m === shown ? "Live preview" : "Live preview (updating)"}
          className="absolute left-1/2 top-1/2 origin-center border-0"
          style={{ width: m.width, height: m.height, transform: `translate(-50%, -50%) scale(${fit})`, visibility: m === shown ? "visible" : "hidden", pointerEvents: "none" }}
        />
      ))}
      {!shown && !error && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-dim" role="status">
          Building live preview…
        </div>
      )}
      {shown && building && (
        <div className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white" role="status">
          Updating…
        </div>
      )}
      {error && (
        <div className="absolute inset-x-0 bottom-0 bg-black/80 p-3 text-xs text-white" role="alert">
          Live preview unavailable: {error.message} {error.recovery && <span className="text-white/70">{error.recovery}</span>}
        </div>
      )}
    </div>
  );
});
