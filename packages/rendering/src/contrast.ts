/**
 * Text contrast, measured on real frames. For each sampled frame the page reports every visible
 * text run (its colour, whether it has a shadow/outline halo, and its line boxes); the frame is
 * captured a second time with the glyphs made transparent, so what's left under each line is the
 * real background — video, image, gradient or caption plate. Each background pixel under a line
 * is compared with the text colour (WCAG contrast ratio); a run is judged by its worst 10%.
 */

export interface TextRun {
  /** Layer DOM id ("l-<scene>-<layer>") or caption id ("cap-<n>"). */
  id: string;
  rgb: [number, number, number];
  halo: boolean;
  /** Line boxes relative to the captured #root, in pixels. */
  rects: { x: number; y: number; w: number; h: number }[];
}

export interface ContrastMeasure {
  id: string;
  frame: number;
  timeSec: number;
  /** 10th-percentile contrast ratio over background pixels under the text (1–21). */
  ratio: number;
  /** Median background colour under the text. */
  background: string;
  text: string;
  halo: boolean;
  samples: number;
}

/** WCAG 2 large-text minimum; video titles and captions are large text. */
export const MIN_CONTRAST = 3;
/** A shadow or outline carries legibility on its own over busy backgrounds; judge more leniently. */
export const MIN_CONTRAST_HALO = 1.8;

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
export const luminance = ([r, g, b]: readonly number[]) => 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
export function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
const hex = (c: readonly number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** Measure each run against an RGB24 background frame (width × height). */
export function measureContrast(runs: TextRun[], rgb: Uint8Array, width: number, height: number, frame: number, timeSec: number): ContrastMeasure[] {
  const out: ContrastMeasure[] = [];
  for (const run of runs) {
    const ratios: number[] = [];
    const bg: number[][] = [];
    for (const r of run.rects) {
      const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
      const x1 = Math.min(width, Math.ceil(r.x + r.w)), y1 = Math.min(height, Math.ceil(r.y + r.h));
      if (x1 - x0 < 2 || y1 - y0 < 2) continue;
      const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 10));
      for (let y = y0; y < y1; y += step)
        for (let x = x0; x < x1; x += step) {
          const i = (y * width + x) * 3;
          const px = [rgb[i]!, rgb[i + 1]!, rgb[i + 2]!];
          ratios.push(contrastRatio(run.rgb, px));
          bg.push(px);
        }
    }
    if (ratios.length < 20) continue;
    ratios.sort((a, b) => a - b);
    const p10 = ratios[Math.floor(ratios.length * 0.1)]!;
    const byLum = bg.map((p) => [luminance(p), p] as const).sort((a, b) => a[0] - b[0]);
    out.push({ id: run.id, frame, timeSec, ratio: Math.round(p10 * 100) / 100, background: hex(byLum[Math.floor(byLum.length / 2)]![1]), text: hex(run.rgb), halo: run.halo, samples: ratios.length });
  }
  return out;
}

export const lowContrast = (m: ContrastMeasure) => m.ratio < (m.halo ? MIN_CONTRAST_HALO : MIN_CONTRAST);

/** Page function: visible DOM text runs under #root. Runs in the browser. */
export const PROBE_TEXT = `(() => {
  const root = document.getElementById("root");
  if (!root) return [];
  const rb = root.getBoundingClientRect();
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 }; };
  const visible = (el) => { let o = 1; for (let e = el; e && e !== root.parentElement; e = e.parentElement) { const s = getComputedStyle(e); if (s.visibility === "hidden" || s.display === "none") return 0; o *= Number(s.opacity); } return o; };
  const runs = new Map();
  const owners = [...root.querySelectorAll('[id^="l-"], .cap')].filter((el) => el.id);
  for (const owner of owners) {
    const ob = owner.getBoundingClientRect();
    const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent || !n.textContent.trim()) continue;
      const el = n.parentElement;
      if (!el || el.closest("svg, canvas")) continue;
      const s = getComputedStyle(el);
      const col = parse(s.color);
      if (!col || col.a < 0.5 || /text/.test(s.webkitBackgroundClip || s.backgroundClip || "")) continue;
      if (visible(el) < 0.85) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const rects = [...range.getClientRects()].map((r) => {
        const x = Math.max(r.left, ob.left), y = Math.max(r.top, ob.top), x2 = Math.min(r.right, ob.right), y2 = Math.min(r.bottom, ob.bottom);
        return { x: x - rb.left, y: y - rb.top, w: x2 - x, h: y2 - y };
      }).filter((r) => r.w > 2 && r.h > 2 && r.x < rb.width && r.y < rb.height);
      if (!rects.length) continue;
      const halo = (s.textShadow && s.textShadow !== "none") || parseFloat(s.webkitTextStrokeWidth || "0") > 0;
      const key = owner.id + "|" + col.rgb.join(",") + "|" + (halo ? 1 : 0);
      const cur = runs.get(key) || { id: owner.id, rgb: col.rgb, halo: !!halo, rects: [] };
      cur.rects.push(...rects);
      runs.set(key, cur);
    }
  }
  return [...runs.values()];
})()`;

/** Page style that hides glyphs only: plates, boxes and everything behind stay. */
export const HIDE_GLYPHS_CSS = `#root [id^="l-"] *, #root [id^="l-"], #root .cap, #root .cap * { color: transparent !important; text-shadow: none !important; -webkit-text-stroke: 0 !important; caret-color: transparent !important; }`;
