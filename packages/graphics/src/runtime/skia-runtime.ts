/**
 * Skia (CanvasKit) graphics runtime, executed inside a compiled composition page.
 * Contract with the HyperFrames runtime:
 *  - async setup is registered on window.__hf.buildReady (render waits for it);
 *  - every "hf-seek" draws each layer as a pure function of the composition time
 *    and completes synchronously (CPU raster surface), so the frame is final when the
 *    listener returns. No wall clock, no requestAnimationFrame, seeded randomness only.
 */
import { sketchIconFor } from "../../../compositor/src/sketch";
import { inflate, lerp3, morphAt, norm, SOLIDS, subdivide, type Tri, type V3 } from "./polyhedra";
import type { Canvas, CanvasKit, Image, Paint, Path, Surface, Typeface } from "canvaskit-wasm";

declare const CanvasKitInit: (opts: { locateFile: (f: string) => string }) => Promise<CanvasKit>;

export interface SkiaLayerSpec {
  id: string;
  /** Frame pixels per 1080p pixel (min side / 1080); px parameters are defined at 1080p. */
  unit?: number;
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
  const u = Number(L.spec.unit ?? 1); // px at 1080p → px at this render size
  const sw = Number(p.strokeWidth ?? 6) * u;
  const vertical = p.direction === "column" || L.spec.height > L.spec.width * 1.2;
  const W0 = L.spec.width;
  const H0 = L.spec.height;
  const n = steps.length;
  const per = Math.max(0.3, Number(p.stepSec ?? Math.min(2.5, (dur * 0.8) / n)));
  const gap = vertical ? H0 * 0.08 : W0 * 0.06;
  const bw = vertical ? W0 * 0.8 : (W0 - gap * (n - 1)) / n - sw;
  const bh = vertical ? (H0 - gap * (n - 1)) / n - sw : Math.min(H0 * 0.6, bw * 0.75);
  const r = rng(L.spec.seed);
  const wobble = Number(p.wobble ?? 0.6) * u;
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
  const corner = Number(p.corner ?? 28) * Number(L.spec.unit ?? 1) * k;
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
    ring.setStrokeWidth(4 * Number(L.spec.unit ?? 1));
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


/**
 * sketch v1: hand-drawn whiteboard illustrations. Each item is an icon chosen from a small
 * built-in line-art set by keyword, drawn on stroke by stroke with a seeded double-line
 * "marker" wobble, then its label is written underneath. Icons are original line art.
 */
const SKETCH_ICONS: Record<string, string> = {
  toast: "M22 40 C10 40 10 18 30 18 C38 10 62 10 70 18 C90 18 90 40 78 40 L78 86 L22 86 Z M34 52 L46 52 M40 64 L58 64 M50 74 L62 74",
  avocado: "M50 8 C34 8 26 30 24 48 C20 74 32 92 50 92 C68 92 80 74 76 48 C74 30 66 8 50 8 Z M50 50 m-14 0 a14 16 0 1 0 28 0 a14 16 0 1 0 -28 0",
  bowl: "M10 44 L90 44 C88 70 72 86 50 86 C28 86 12 70 10 44 Z M30 44 C32 30 44 26 50 34 C56 24 70 30 70 44 M84 18 L60 46",
  knife: "M12 70 L62 26 C74 16 90 20 86 30 L40 72 Z M40 72 L50 82 C46 88 36 88 30 80 Z",
  spread: "M12 70 L62 26 C74 16 90 20 86 30 L40 72 Z M18 88 C34 80 52 92 70 84 C78 80 86 84 92 88",
  chili: "M24 30 C18 60 44 92 86 84 C60 76 44 58 40 30 Z M30 30 C30 20 38 14 46 18 M34 22 L28 10",
  lemon: "M14 50 C14 28 34 16 50 16 C66 16 86 28 86 50 C86 72 66 84 50 84 C34 84 14 72 14 50 Z M8 50 L14 50 M86 50 L92 50 M34 42 C40 36 48 34 56 36",
  salt: "M30 30 L70 30 L76 88 L24 88 Z M34 30 C34 16 66 16 66 30 M42 20 L42 22 M50 18 L50 20 M58 20 L58 22",
  clock: "M50 10 C72 10 90 28 90 50 C90 72 72 90 50 90 C28 90 10 72 10 50 C10 28 28 10 50 10 Z M50 26 L50 50 L66 60",
  check: "M50 10 C72 10 90 28 90 50 C90 72 72 90 50 90 C28 90 10 72 10 50 C10 28 28 10 50 10 Z M30 52 L44 66 L72 36",
  bulb: "M50 10 C30 10 20 26 22 42 C24 56 36 62 38 74 L62 74 C64 62 76 56 78 42 C80 26 70 10 50 10 Z M40 82 L60 82 M44 90 L56 90",
  plate: "M50 18 C78 18 94 34 94 50 C94 66 78 82 50 82 C22 82 6 66 6 50 C6 34 22 18 50 18 Z M50 34 C66 34 76 42 76 50 C76 58 66 66 50 66 C34 66 24 58 24 50 C24 42 34 34 50 34 Z",
  laptop: "M20 22 L80 22 L80 66 L20 66 Z M8 78 L92 78 L84 66 L16 66 Z",
  calendar: "M14 22 L86 22 L86 88 L14 88 Z M14 40 L86 40 M32 12 L32 30 M68 12 L68 30 M30 56 L40 56 M48 56 L58 56 M66 56 L76 56 M30 72 L40 72 M48 72 L58 72",
  person: "M50 12 C62 12 68 22 68 32 C68 44 60 52 50 52 C40 52 32 44 32 32 C32 22 38 12 50 12 Z M16 92 C18 70 32 60 50 60 C68 60 82 70 84 92",
  star: "M50 8 L61 36 L92 38 L68 58 L76 90 L50 72 L24 90 L32 58 L8 38 L39 36 Z",
  heart: "M50 86 C20 64 8 46 14 30 C20 14 42 12 50 30 C58 12 80 14 86 30 C92 46 80 64 50 86 Z",
  arrow: "M10 50 L86 50 M64 28 L88 50 L64 72",
  idea: "M50 10 C30 10 20 26 22 42 C24 56 36 62 38 74 L62 74 C64 62 76 56 78 42 C80 26 70 10 50 10 Z M40 82 L60 82 M10 20 L18 26 M90 20 L82 26 M4 46 L14 46 M96 46 L86 46",
};
function sketch(ck: CanvasKit, c: Canvas, L: Layer, t: number, dur: number) {
  const p = L.spec.params;
  const items = String(p.items ?? "idea").split("|").map((x) => x.trim()).filter(Boolean).slice(0, 4);
  const labels = String(p.labels ?? "").split("|").map((x) => x.trim());
  const ink = String(p.ink ?? "#1f2937");
  const accent = String(p.accent ?? "#f59e0b");
  const n = items.length;
  const W0 = L.spec.width;
  const H0 = L.spec.height;
  const per = Math.max(0.4, Number(p.drawSec ?? Math.min(2, (dur * 0.7) / n)));
  const cell = Math.min(W0 / n, H0 * 0.78);
  const iconSize = cell * 0.72;
  const r = rng(L.spec.seed);
  const paint = new ck.Paint();
  paint.setAntiAlias(true);
  paint.setStyle(ck.PaintStyle.Stroke);
  paint.setStrokeCap(ck.StrokeCap.Round);
  paint.setStrokeJoin(ck.StrokeJoin.Round);
  const provider = ck.TypefaceFontProvider.Make();
  items.forEach((item, i) => {
    const local = clamp01((t - i * per) / per);
    if (local <= 0) return;
    const icon = SKETCH_ICONS[sketchIconFor(item, Object.keys(SKETCH_ICONS))]!;
    const path = ck.Path.MakeFromSVGString(icon);
    if (!path) return;
    const cx = (W0 / n) * (i + 0.5);
    const top = (H0 - cell) / 2 + cell * 0.02;
    const scale = iconSize / 100;
    const drawT = ease(clamp01(local / 0.7));
    // Two slightly offset passes give a marker-on-whiteboard line.
    for (let pass = 0; pass < 2; pass++) {
      const dx = (r() - 0.5) * 2.4 * Number(L.spec.unit ?? 1);
      const dy = (r() - 0.5) * 2.4 * Number(L.spec.unit ?? 1);
      const tr = trim(path, drawT);
      if (!tr) continue;
      c.save();
      c.translate(cx - iconSize / 2 + dx, top + dy);
      c.scale(scale, scale);
      paint.setStrokeWidth(((pass === 0 ? 7 : 3) * Math.max(0.5, iconSize / 300)) / scale);
      paint.setColor(hex(ck, pass === 0 ? ink : accent, pass === 0 ? 1 : 0.55));
      c.drawPath(tr, paint);
      c.restore();
      if (tr !== path) tr.delete();
    }
    path.delete();
    const labelT = clamp01((local - 0.6) / 0.35);
    const label = labels[i] ?? "";
    if (labelT > 0 && label) {
      const shown = label.slice(0, Math.ceil(label.length * labelT));
      const para = paragraph(ck, provider, L, shown, Math.min(cell * 0.13, 64), ink, W0 / n - 16);
      para.layout(W0 / n - 16);
      c.drawParagraph(para, cx - (W0 / n - 16) / 2, top + iconSize + cell * 0.04);
      para.delete();
    }
  });
  provider.delete();
  paint.delete();
}


/**
 * platonic-morph v1: a lit, slowly turning 3D platonic solid that mutates through a sequence of
 * solids. Each solid inflates into a sphere and the next deflates out of it (seamless at the
 * sphere); faces drift through the palette, edges curve as it inflates. Pure function of t.
 */
const platonicCache = new Map<string, Tri[]>();
function platonicMorph(ck: CanvasKit, c: Canvas, L: Layer, t: number) {
  const p = L.spec.params;
  const seq = String(p.sequence ?? "tetrahedron,cube,octahedron,dodecahedron,icosahedron").split(",").map((x) => x.trim().toLowerCase()).filter((x) => SOLIDS[x]);
  if (!seq.length) return;
  const hold = Math.max(0.2, Number(p.holdSec ?? 1.6));
  const morph = Math.max(0.2, Number(p.morphSec ?? 1.4));
  const detail = Math.max(1, Math.min(3, Math.round(Number(p.detail ?? 2))));
  const st = morphAt(t, seq.length, hold, morph);
  const solid = SOLIDS[seq[st.index]!]!;
  const key = `${solid.name}@${detail}`;
  if (!platonicCache.has(key)) platonicCache.set(key, subdivide(solid, detail));
  const tris = platonicCache.get(key)!;
  const palette = String(p.colors ?? "#8b5cf6,#ec4899,#fb7a5a").split(",").map((x) => x.trim()).filter((x) => /^#[0-9a-f]{6}$/i.test(x));
  const cols = (palette.length ? palette : ["#8b5cf6"]).map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
  const W = L.spec.width, H = L.spec.height, unit = L.spec.unit ?? 1;
  const R = Math.min(W, H) * 0.5 * Math.max(0.2, Math.min(1.2, Number(p.size ?? 0.85)));
  const cx = W / 2, cy = H / 2, D = 4.2;
  const spin = Number(p.spin ?? 0.35);
  const yaw = t * spin * Math.PI * 0.6, pitch = 0.45 + 0.22 * Math.sin(t * 0.37), roll = 0.12 * Math.sin(t * 0.23);
  const [cyw, syw, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
  const breathe = 1 + 0.035 * Math.sin(t * 1.3) + 0.06 * st.inflation;
  const rot = (q: V3): V3 => {
    let [x, y, z] = q;
    [x, z] = [x * cyw + z * syw, -x * syw + z * cyw];
    [y, z] = [y * cp - z * sp, y * sp + z * cp];
    [x, y] = [x * cr - y * sr, x * sr + y * cr];
    return [x * breathe, y * breathe, z * breathe];
  };
  const proj = (q: V3): [number, number] => {
    const k = D / (D - q[2]);
    return [cx + q[0] * R * k, cy - q[1] * R * k];
  };
  const light = norm([-0.45, 0.62, 0.65]);
  const half = norm([light[0], light[1], light[2] + 1]);
  const faces = solid.faces.length;
  // Current palette colour, for the glow behind the solid.
  const gpos = (st.progress * 1.5 * cols.length) % cols.length;
  const g0 = cols[Math.floor(gpos)]!, g1 = cols[(Math.floor(gpos) + 1) % cols.length]!, gf = gpos - Math.floor(gpos);
  const glowRgb = g0.map((v, k) => Math.round(v + (g1[k]! - v) * gf));
  if (p.glow !== false) {
    const halo: Paint = new ck.Paint();
    halo.setAntiAlias(true);
    halo.setShader(ck.Shader.MakeRadialGradient([cx, cy], R * 1.9, [ck.Color(glowRgb[0]!, glowRgb[1]!, glowRgb[2]!, 0.34), ck.Color(glowRgb[0]!, glowRgb[1]!, glowRgb[2]!, 0)], [0, 1], ck.TileMode.Clamp));
    c.drawCircle(cx, cy, R * 1.9, halo);
    halo.delete();
    // A soft shadow on an imagined floor, so the solid floats.
    const shadow: Paint = new ck.Paint();
    shadow.setAntiAlias(true);
    shadow.setColor(ck.Color(0, 0, 0, 0.45));
    shadow.setMaskFilter(ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, R * 0.09, false));
    const sw = R * (1.05 + 0.08 * st.inflation);
    c.drawOval(ck.LTRBRect(cx - sw, cy + R * 1.18, cx + sw, cy + R * 1.34), shadow);
    shadow.delete();
  }
  const drawn: { z: number; pts: [number, number][]; rgb: number[]; a: number }[] = [];
  for (const tri of tris) {
    const q = tri.p.map((v) => rot(inflate(v, st.inflation))) as [V3, V3, V3];
    const e1: V3 = [q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]];
    const e2: V3 = [q[2][0] - q[0][0], q[2][1] - q[0][1], q[2][2] - q[0][2]];
    const n = norm([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]);
    if (n[2] <= 0) continue; // facing away
    const diff = Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
    const spec = Math.pow(Math.max(0, n[0] * half[0] + n[1] * half[1] + n[2] * half[2]), 28);
    // Palette position drifts with time and differs per original face.
    const pos = ((tri.face / faces) * 0.6 + st.progress * 1.5) * cols.length;
    const i0 = Math.floor(pos) % cols.length, i1 = (i0 + 1) % cols.length, f = pos - Math.floor(pos);
    const base = cols[i0]!.map((v, k) => v + (cols[i1]![k]! - v) * f);
    // Key light, a rim light from behind (edges glow in the palette colour) and a specular hit.
    const rim = Math.pow(1 - n[2], 2.2) * 0.55;
    const shade = 0.32 + 0.82 * diff;
    const rgb = base.map((v, k) => Math.min(255, v * shade + glowRgb[k]! * rim + 255 * spec * 0.6));
    drawn.push({ z: (q[0][2] + q[1][2] + q[2][2]) / 3, pts: q.map(proj), rgb, a: 0.94 });
  }
  drawn.sort((a, b) => a.z - b.z);
  const fill: Paint = new ck.Paint();
  fill.setAntiAlias(true);
  const seam: Paint = new ck.Paint();
  seam.setAntiAlias(true);
  seam.setStyle(ck.PaintStyle.Stroke);
  seam.setStrokeWidth(Math.max(0.8, 0.9 * unit));
  for (const d of drawn) {
    const pb = new ck.PathBuilder();
    pb.moveTo(d.pts[0]![0], d.pts[0]![1]);
    pb.lineTo(d.pts[1]![0], d.pts[1]![1]);
    pb.lineTo(d.pts[2]![0], d.pts[2]![1]);
    pb.close();
    const path = pb.detach();
    const col = ck.Color(Math.round(d.rgb[0]!), Math.round(d.rgb[1]!), Math.round(d.rgb[2]!), d.a);
    fill.setColor(col);
    seam.setColor(col);
    c.drawPath(path, fill);
    c.drawPath(path, seam); // closes hairline gaps between neighbouring triangles
    path.delete();
  }
  // Edges of the solid itself: curved as it inflates, fading toward the sphere.
  const edgeA = (1 - st.inflation * 0.85) * (p.edges === false ? 0 : 1);
  if (edgeA > 0.02) {
    const edgeHex = String(p.edgeColor ?? "#ffffff");
    const glow: Paint = new ck.Paint();
    glow.setAntiAlias(true);
    glow.setStyle(ck.PaintStyle.Stroke);
    glow.setStrokeCap(ck.StrokeCap.Round);
    glow.setStrokeWidth(9 * unit);
    glow.setColor(hex(ck, edgeHex, 0.14 * edgeA));
    const line: Paint = new ck.Paint();
    line.setAntiAlias(true);
    line.setStyle(ck.PaintStyle.Stroke);
    line.setStrokeCap(ck.StrokeCap.Round);
    line.setStrokeWidth(2.4 * unit);
    line.setColor(hex(ck, edgeHex, 0.92 * edgeA));
    for (const [a, b] of solid.edges) {
      const va = solid.vertices[a]!, vb = solid.vertices[b]!;
      const mid = rot(inflate(lerp3(va, vb, 0.5), st.inflation));
      if (mid[2] < -0.05) continue; // behind the solid
      const pb = new ck.PathBuilder();
      for (let k = 0; k <= 16; k++) {
        const [x, y] = proj(rot(inflate(lerp3(va, vb, k / 16), st.inflation)));
        if (k === 0) pb.moveTo(x, y);
        else pb.lineTo(x, y);
      }
      const path = pb.detach();
      c.drawPath(path, glow);
      c.drawPath(path, line);
      path.delete();
    }
    const dot: Paint = new ck.Paint();
    dot.setAntiAlias(true);
    dot.setColor(hex(ck, edgeHex, edgeA));
    for (const v of solid.vertices) {
      const q = rot(inflate(v, st.inflation));
      if (q[2] < -0.05) continue;
      const [x, y] = proj(q);
      c.drawCircle(x, y, 4.2 * unit, dot);
    }
    glow.delete();
    line.delete();
    dot.delete();
  }
  fill.delete();
  seam.delete();
}

const COMPONENTS: Record<string, (ck: CanvasKit, c: Canvas, L: Layer, t: number, dur: number) => void> = {
  "path-diagram@1": pathDiagram,
  "sketch@1": sketch,
  "mask-reveal@1": maskReveal,
  "type-overlay@1": typeOverlay,
  "platonic-morph@1": platonicMorph,
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
