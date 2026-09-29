/**
 * Skia (CanvasKit) graphics runtime, executed inside a compiled composition page.
 * Contract with the HyperFrames runtime:
 *  - async setup is registered on window.__hf.buildReady (render waits for it);
 *  - every "hf-seek" draws each layer as a pure function of the composition time
 *    and completes synchronously (CPU raster surface), so the frame is final when the
 *    listener returns. No wall clock, no requestAnimationFrame, seeded randomness only.
 */
import type { Canvas, CanvasKit, Image, Paint, Path, Surface, Typeface } from "canvaskit-wasm";

declare const CanvasKitInit: (opts: { locateFile: (f: string) => string }) => Promise<CanvasKit>;

export interface SkiaLayerSpec {
  id: string;
  component: string;
  version: number;
  params: Record<string, number | string | boolean>;
  startSec: number;
  durationSec: number;
  width: number;
  height: number;
  seed: number;
  /** Param name → bundle-relative URL (images). */
  assetUrls: Record<string, string>;
  fontUrl: string;
}

interface Layer {
  spec: SkiaLayerSpec;
  canvasEl: HTMLCanvasElement;
  surface: Surface;
  images: Record<string, Image>;
  typeface: Typeface;
  lastT: number | null;
}

type W = typeof window & {
  __hf?: { buildReady?: Record<string, Promise<unknown>> };
  __vsGraphics?: SkiaLayerSpec[] | { backend?: string }[];
  __vsSkiaReport?: { layers: number; frames: number; errors: string[] };
};
const w = window as W;

function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** CanvasKit 0.42 returns null for makeTrimmed(0, 1); a complete trim is the path itself. */
function trim(path: Path, u: number): Path | null {
  if (u >= 0.9999) return path;
  if (u <= 0) return null;
  return path.makeTrimmed(0, u, false);
}
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
function hex(ck: CanvasKit, h: string, alpha = 1) {
  const v = /^#([0-9a-f]{6})$/i.test(h) ? h : "#ffffff";
  return ck.Color(parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), alpha);
}

// ---------------------------------------------------------------------------
// Components (versioned). Each is draw(ck, canvas, layer, t, duration).
// ---------------------------------------------------------------------------

/** path-diagram v1: sequential steps drawn as boxes with arrows; each step reveals in turn. */
function pathDiagram(ck: CanvasKit, c: Canvas, L: Layer, t: number, dur: number) {
  const p = L.spec.params;
  const steps = String(p.steps ?? "Step 1|Step 2|Step 3").split("|").map((s) => s.trim()).filter(Boolean).slice(0, 6);
  const stroke = hex(ck, String(p.color ?? "#1f2937"));
  const accent = hex(ck, String(p.accent ?? "#f59e0b"));
  const ink = String(p.ink ?? p.color ?? "#1f2937");
  const sw = Number(p.strokeWidth ?? 6);
  const vertical = p.direction === "column" || L.spec.height > L.spec.width * 1.2;
  const W0 = L.spec.width;
  const H0 = L.spec.height;
  const n = steps.length;
  const per = Math.max(0.3, Number(p.stepSec ?? Math.min(2.5, (dur * 0.8) / n)));
  const gap = vertical ? H0 * 0.08 : W0 * 0.06;
  const bw = vertical ? W0 * 0.8 : (W0 - gap * (n - 1)) / n - sw;
  const bh = vertical ? (H0 - gap * (n - 1)) / n - sw : Math.min(H0 * 0.6, bw * 0.75);
  const r = rng(L.spec.seed);
  const wobble = Number(p.wobble ?? 0.6);
  const paint = new ck.Paint();
  paint.setAntiAlias(true);
  paint.setStyle(ck.PaintStyle.Stroke);
  paint.setStrokeWidth(sw);
  paint.setStrokeCap(ck.StrokeCap.Round);
  paint.setStrokeJoin(ck.StrokeJoin.Round);
  const fill = new ck.Paint();
  fill.setAntiAlias(true);
  const provider = ck.TypefaceFontProvider.Make();
  for (let i = 0; i < n; i++) {
    const local = clamp01((t - i * per) / per);
    const x = vertical ? (W0 - bw) / 2 : sw / 2 + i * (bw + gap);
    const y = vertical ? sw / 2 + i * (bh + gap) : (H0 - bh) / 2;
    // Box outline drawn progressively along its perimeter (hand-drawn wobble is seeded).
    const pb = new ck.PathBuilder();
    const j = () => (r() - 0.5) * wobble * sw;
    pb.moveTo(x + 18 + j(), y + j());
    pb.lineTo(x + bw - 18 + j(), y + j());
    pb.quadTo(x + bw, y, x + bw + j(), y + 18 + j());
    pb.lineTo(x + bw + j(), y + bh - 18 + j());
    pb.quadTo(x + bw, y + bh, x + bw - 18 + j(), y + bh + j());
    pb.lineTo(x + 18 + j(), y + bh + j());
    pb.quadTo(x, y + bh, x + j(), y + bh - 18 + j());
    pb.lineTo(x + j(), y + 18 + j());
    pb.quadTo(x, y, x + 18, y);
    const box = pb.detach();
    const boxT = clamp01(local / 0.55);
    if (boxT > 0) {
      const trimmed = trim(box, boxT >= 1 ? 1 : ease(boxT));
      if (trimmed) {
        paint.setColor(i === n - 1 ? accent : stroke);
        c.drawPath(trimmed, paint);
        if (trimmed !== box) trimmed.delete();
      }
    }
    box.delete();
    // Label fades/types in after the box.
    const labelT = clamp01((local - 0.45) / 0.45);
    if (labelT > 0) {
      const text = steps[i]!;
      const shown = text.slice(0, Math.ceil(text.length * labelT));
      const para = paragraph(ck, provider, L, shown, Math.min(bh * 0.28, 64), ink, bw - 36);
      para.layout(bw - 36);
      c.drawParagraph(para, x + 18, y + (bh - para.getHeight()) / 2);
      para.delete();
    }
    // Arrow to the next step.
    if (i < n - 1) {
      const aT = clamp01((local - 0.8) / 0.2);
      if (aT > 0) {
        const ab = new ck.PathBuilder();
        const [x1, y1, x2, y2] = vertical ? [W0 / 2, y + bh + sw, W0 / 2, y + bh + gap - sw] : [x + bw + sw, H0 / 2, x + bw + gap - sw, H0 / 2];
        ab.moveTo(x1, y1);
        ab.lineTo(x2, y2);
        const head = 14;
        if (vertical) {
          ab.moveTo(x2 - head, y2 - head);
          ab.lineTo(x2, y2);
          ab.lineTo(x2 + head, y2 - head);
        } else {
          ab.moveTo(x2 - head, y2 - head);
          ab.lineTo(x2, y2);
          ab.lineTo(x2 - head, y2 + head);
        }
        const arrow = ab.detach();
        const tr = trim(arrow, aT);
        if (tr) {
          paint.setColor(stroke);
          c.drawPath(tr, paint);
          if (tr !== arrow) tr.delete();
        }
        arrow.delete();
      }
    }
  }
  provider.delete();
  paint.delete();
  fill.delete();
}

function paragraph(ck: CanvasKit, provider: ReturnType<CanvasKit["TypefaceFontProvider"]["Make"]>, L: Layer, text: string, size: number, color: string, _width: number) {
  provider.registerFont(fontBytes.get(L.spec.fontUrl)!, "VSFont");
  const style = new ck.ParagraphStyle({ textStyle: { color: hex(ck, color), fontFamilies: ["VSFont"], fontSize: size, fontStyle: { weight: ck.FontWeight.Bold } }, textAlign: ck.TextAlign.Center, maxLines: 3 });
  const b = ck.ParagraphBuilder.MakeFromFontProvider(style, provider);
  b.addText(text);
  const p = b.build();
  b.delete();
  return p;
}

/** mask-reveal v1: an unchanged product image revealed from a close-up circle to the full frame. */
function maskReveal(ck: CanvasKit, c: Canvas, L: Layer, t: number, dur: number) {
  const img = L.images.image;
  const W0 = L.spec.width;
  const H0 = L.spec.height;
  if (!img) return;
  const p = L.spec.params;
  const fx = Number(p.focalX ?? 0.5);
  const fy = Number(p.focalY ?? 0.5);
  const zoom = Math.max(1, Number(p.zoom ?? 2.2));
  const revealSec = Math.min(dur * 0.8, Number(p.revealSec ?? 2.2));
  const k = ease(clamp01(t / revealSec));
  // Fit image (contain) into the layer box.
  const iw = img.width();
  const ih = img.height();
  const s = Math.min(W0 / iw, H0 / ih);
  const dw = iw * s;
  const dh = ih * s;
  const dx = (W0 - dw) / 2;
  const dy = (H0 - dh) / 2;
  // Scale around the focal point from `zoom` to 1.
  const scale = zoom + (1 - zoom) * k;
  const cx = dx + dw * fx;
  const cy = dy + dh * fy;
  const maxR = Math.hypot(Math.max(cx, W0 - cx), Math.max(cy, H0 - cy));
  const radius = Math.min(W0, H0) * 0.22 + (maxR - Math.min(W0, H0) * 0.22) * k;
  const corner = Number(p.corner ?? 28) * k;
  c.save();
  const rr = ck.RRectXY(ck.LTRBRect(cx - radius, cy - radius, cx + radius, cy + radius), radius * (1 - k) + corner, radius * (1 - k) + corner);
  c.clipRRect(k >= 1 ? ck.RRectXY(ck.LTRBRect(dx, dy, dx + dw, dy + dh), corner, corner) : rr, ck.ClipOp.Intersect, true);
  c.translate(cx, cy);
  c.scale(scale, scale);
  c.translate(-cx, -cy);
  const paint = new ck.Paint();
  paint.setAntiAlias(true);
  c.drawImageRectOptions(img, ck.LTRBRect(0, 0, iw, ih), ck.LTRBRect(dx, dy, dx + dw, dy + dh), ck.FilterMode.Linear, ck.MipmapMode.None, paint);
  paint.delete();
  c.restore();
  // Ring that follows the mask edge while revealing.
  if (k < 1) {
    const ring = new ck.Paint();
    ring.setAntiAlias(true);
    ring.setStyle(ck.PaintStyle.Stroke);
    ring.setStrokeWidth(4);
    ring.setColor(hex(ck, String(p.ringColor ?? "#ffffff"), 0.7 * (1 - k)));
    c.drawRRect(rr, ring);
    ring.delete();
  }
}

/** type-overlay v1: annotation text with an accent underline that draws on. */
function typeOverlay(ck: CanvasKit, c: Canvas, L: Layer, t: number, dur: number) {
  const p = L.spec.params;
  const text = String(p.text ?? "");
  const size = Number(p.size ?? Math.min(L.spec.height * 0.45, 96));
  const k = ease(clamp01(t / Math.min(dur * 0.5, Number(p.revealSec ?? 0.9))));
  const provider = ck.TypefaceFontProvider.Make();
  const para = paragraph(ck, provider, L, text, size, String(p.color ?? "#ffffff"), L.spec.width);
  para.layout(L.spec.width);
  const ty = (L.spec.height - para.getHeight()) / 2 - size * 0.1;
  c.save();
  c.clipRect(ck.LTRBRect(0, 0, L.spec.width * k + 1, L.spec.height), ck.ClipOp.Intersect, true);
  c.drawParagraph(para, 0, ty);
  c.restore();
  const u = ease(clamp01((t - 0.3) / 0.8));
  if (u > 0) {
    const lw = Math.min(para.getLongestLine(), L.spec.width);
    const x0 = (L.spec.width - lw) / 2;
    const y = ty + para.getHeight() + size * 0.12;
    const pb = new ck.PathBuilder();
    pb.moveTo(x0, y);
    pb.cubicTo(x0 + lw * 0.3, y + size * 0.08, x0 + lw * 0.7, y - size * 0.06, x0 + lw, y + size * 0.02);
    const path: Path = pb.detach();
    const tr = trim(path, u);
    const paint: Paint = new ck.Paint();
    paint.setAntiAlias(true);
    paint.setStyle(ck.PaintStyle.Stroke);
    paint.setStrokeCap(ck.StrokeCap.Round);
    paint.setStrokeWidth(Math.max(4, size * 0.08));
    paint.setColor(hex(ck, String(p.accent ?? "#f59e0b")));
    if (tr) c.drawPath(tr, paint);
    if (tr && tr !== path) tr.delete();
    path.delete();
    paint.delete();
  }
  para.delete();
  provider.delete();
}

const COMPONENTS: Record<string, (ck: CanvasKit, c: Canvas, L: Layer, t: number, dur: number) => void> = {
  "path-diagram@1": pathDiagram,
  "mask-reveal@1": maskReveal,
  "type-overlay@1": typeOverlay,
};

// ---------------------------------------------------------------------------
const fontBytes = new Map<string, ArrayBuffer>();
let CK: CanvasKit | null = null;
const layers: Layer[] = [];
const report = (w.__vsSkiaReport = { layers: 0, frames: 0, errors: [] as string[] });

async function setup() {
  const specs = ((w.__vsGraphics ?? []) as (SkiaLayerSpec & { backend?: string })[]).filter((s) => s.backend === "skia");
  if (!specs.length) return;
  CK = await CanvasKitInit({ locateFile: (f) => `vendor/${f}` });
  for (const spec of specs) {
    const key = `${spec.component}@${spec.version}`;
    if (!COMPONENTS[key]) throw new Error(`Unsupported Skia component ${key}`);
    if (!fontBytes.has(spec.fontUrl)) fontBytes.set(spec.fontUrl, await (await fetch(spec.fontUrl)).arrayBuffer());
    const images: Record<string, Image> = {};
    for (const [name, url] of Object.entries(spec.assetUrls)) {
      const img = CK.MakeImageFromEncoded(new Uint8Array(await (await fetch(url)).arrayBuffer()));
      if (!img) throw new Error(`Could not decode image for ${spec.id}.${name}`);
      images[name] = img;
    }
    const canvasEl = document.getElementById(`gfx-${spec.id}`) as HTMLCanvasElement | null;
    if (!canvasEl) throw new Error(`Missing canvas for ${spec.id}`);
    const surface = CK.MakeSWCanvasSurface(canvasEl);
    if (!surface) throw new Error(`Could not create a Skia surface for ${spec.id}`);
    const typeface = CK.Typeface.MakeTypefaceFromData(fontBytes.get(spec.fontUrl)!);
    if (!typeface) throw new Error(`Font ${spec.fontUrl} could not be loaded by Skia`);
    layers.push({ spec, canvasEl, surface, images, typeface, lastT: null });
  }
  report.layers = layers.length;
}

function drawAll(time: number) {
  if (!CK) return;
  for (const L of layers) {
    const t = time - L.spec.startSec;
    // Off-screen (the layer's scene clip is hidden): nothing to draw.
    if (t < -1e-6 || t > L.spec.durationSec + 1e-6) continue;
    const tt = Math.max(0, Math.min(t, L.spec.durationSec));
    if (L.lastT === tt) continue; // idempotent re-seek
    try {
      const c = L.surface.getCanvas();
      c.clear(CK.TRANSPARENT);
      COMPONENTS[`${L.spec.component}@${L.spec.version}`]!(CK, c, L, tt, L.spec.durationSec);
      L.surface.flush();
      L.lastT = tt;
      report.frames++;
    } catch (e) {
      report.errors.push(String(e));
      throw e;
    }
  }
}

w.__hf = w.__hf || {};
w.__hf.buildReady = w.__hf.buildReady || {};
const ready = setup();
w.__hf.buildReady["vs-skia"] = ready;
window.addEventListener("hf-seek", (e: Event) => {
  const d = (e as CustomEvent<{ time: number; waitUntil?: (p: Promise<unknown>) => void }>).detail;
  const p = ready.then(() => drawAll(d.time));
  d.waitUntil?.(p);
});
// Preview (no hf-seek): draw the first frame once ready so the canvas is never blank.
ready.then(() => drawAll(0)).catch((e) => report.errors.push(String(e)));
