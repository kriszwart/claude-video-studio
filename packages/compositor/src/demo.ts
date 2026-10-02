import type { Scene } from "@vs/domain";

/**
 * Screen demo motion (pure): one camera on the screenshot and one cursor, as exact values for
 * every frame of the scene. The camera zooms in log space (1×→2× takes as long as 2×→4×), eases
 * one move at a time, and never shows past the screen's edges when zoomed. The cursor glides to
 * each step on a slight arc, presses on clicks, and lives inside the camera so it zooms with it.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface DemoFrame {
  /** Camera: container transform translate(tx, ty) scale(zoom), origin top-left. */
  zoom: number;
  tx: number;
  ty: number;
  /** Cursor position (container pixels) and press scale. */
  cx: number;
  cy: number;
  press: number;
}
export interface DemoClick {
  /** Scene-local frame of the press. */
  frame: number;
  x: number;
  y: number;
  label: string;
}

type Demo = NonNullable<Scene["demo"]>;
type Key = { t: number; zoom: number; x: number; y: number };

const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

/** Fit an image of the given size inside a box, centred (object-fit: contain). */
export function containRect(box: Rect, imgW?: number, imgH?: number): Rect {
  if (!imgW || !imgH) return box;
  const s = Math.min(box.w / imgW, box.h / imgH);
  const w = imgW * s, h = imgH * s;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** Keep the view inside the screen (with a small margin) at this zoom; when the whole screen fits, frame it as laid out. */
function clampCentre(x: number, y: number, zoom: number, screen: Rect, W: number, H: number): [number, number] {
  const hw = W / (2 * zoom), hh = H / (2 * zoom);
  const m = (0.03 * W) / zoom;
  const fit = (v: number, lo: number, hi: number, mid: number) => (lo > hi ? mid : Math.min(hi, Math.max(lo, v)));
  return [fit(x, screen.x + hw - m, screen.x + screen.w - hw + m, W / 2), fit(y, screen.y + hh - m, screen.y + screen.h - hh + m, H / 2)];
}

/**
 * `tailFrames`: the end of the scene that the next scene's transition covers; the pull-back
 * finishes before it. `zoomed` is the span (scene-local frames) during which the camera is in
 * close, so other text in the scene can step aside.
 */
export function demoMotion(demo: Demo, screen: Rect, W: number, H: number, fps: number, durationFrames: number, tailFrames = 0): { frames: DemoFrame[]; clicks: DemoClick[]; zoomed: [number, number] | null } {
  const at = (s: { x: number; y: number }) => ({ x: screen.x + s.x * screen.w, y: screen.y + s.y * screen.h });
  const steps = demo.steps.filter((s) => s.atFrames < durationFrames).sort((a, b) => a.atFrames - b.atFrames);
  // At 1× the camera rests where the layout put the screen (no shift).
  const centre = { x: W / 2, y: H / 2 };

  // Camera keys: hold between them, one eased move into each.
  const cam: { from: Key; to: Key }[] = [];
  let prev: Key = { t: 0, zoom: 1, ...centre };
  for (const s of steps) {
    const p = at(s);
    const room = s.atFrames - prev.t;
    const move = Math.max(1, Math.min(Math.round(0.9 * fps), room - 2));
    const next: Key = { t: s.atFrames, zoom: s.zoom, x: p.x, y: p.y };
    cam.push({ from: { ...prev, t: s.atFrames - move }, to: next });
    prev = next;
  }
  const end = durationFrames - tailFrames;
  if (demo.zoomOut && steps.length) {
    const move = Math.round(0.8 * fps);
    const start = Math.max(prev.t + Math.round(0.6 * fps), end - move - Math.round(0.4 * fps));
    if (start + move <= durationFrames) cam.push({ from: { ...prev, t: start }, to: { t: start + move, zoom: 1, ...centre } });
  }
  const zoomedIn = cam.filter((m) => m.to.zoom > 1.05);
  const zoomed: [number, number] | null = zoomedIn.length ? [zoomedIn[0]!.from.t, cam.at(-1)!.to.zoom <= 1.05 ? cam.at(-1)!.from.t : durationFrames] : null;
  const camAt = (f: number): Key => {
    let k: Key = { t: 0, zoom: 1, ...centre };
    for (const m of cam) {
      if (f >= m.to.t) k = m.to;
      else if (f > m.from.t) {
        const p = easeInOut((f - m.from.t) / (m.to.t - m.from.t));
        return { t: f, zoom: Math.exp(lerp(Math.log(m.from.zoom), Math.log(m.to.zoom), p)), x: lerp(m.from.x, m.to.x, p), y: lerp(m.from.y, m.to.y, p) };
      } else break;
    }
    return k;
  };

  // Cursor: from a rest point on the screen to each step, arriving with the camera.
  const rest = { x: screen.x + screen.w * 0.72, y: screen.y + screen.h * 0.84 };
  const legs: { t0: number; t1: number; a: { x: number; y: number }; b: { x: number; y: number } }[] = [];
  let pos = rest, free = 0;
  for (const s of steps) {
    const b = at(s);
    const len = Math.max(1, Math.min(Math.round(0.7 * fps), s.atFrames - free - 1));
    legs.push({ t0: s.atFrames - len, t1: s.atFrames, a: pos, b });
    pos = b;
    free = s.atFrames + (s.action === "click" ? 5 : 1);
  }
  const cursorAt = (f: number) => {
    let p = rest;
    for (const l of legs) {
      if (f >= l.t1) p = l.b;
      else if (f > l.t0) {
        const u = easeInOut((f - l.t0) / (l.t1 - l.t0));
        const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
        const arc = Math.sin(Math.PI * u) * 0.08;
        return { x: lerp(l.a.x, l.b.x, u) - dy * arc, y: lerp(l.a.y, l.b.y, u) + dx * arc };
      } else break;
    }
    return p;
  };
  const clicks: DemoClick[] = steps.filter((s) => s.action === "click").map((s) => ({ frame: s.atFrames + 1, ...at(s), label: s.label }));

  const frames: DemoFrame[] = [];
  for (let f = 0; f < durationFrames; f++) {
    const k = camAt(f);
    const [x, y] = clampCentre(k.x, k.y, k.zoom, screen, W, H);
    const c = cursorAt(f);
    const pressed = clicks.some((cl) => f >= cl.frame && f < cl.frame + 4);
    frames.push({ zoom: k.zoom, tx: W / 2 - k.zoom * x, ty: H / 2 - k.zoom * y, cx: c.x, cy: c.y, press: pressed ? 0.82 : 1 });
  }
  return { frames, clicks, zoomed };
}
