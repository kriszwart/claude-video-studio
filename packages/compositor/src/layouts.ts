import type { AspectRatio } from "@vs/domain";

/** A box in normalised frame coordinates (0..1), relative to the safe area unless `bleed`. */
export interface SlotBox {
  x: number;
  y: number;
  w: number;
  h: number;
  align?: "start" | "center" | "end";
  /** Vertical alignment of content inside the box. */
  valign?: "start" | "center" | "end";
  /** Ignore the safe area (full-frame media). */
  bleed?: boolean;
  z?: number;
}

export type LayoutDef = Record<AspectRatio, Record<string, SlotBox>>;

const full: SlotBox = { x: 0, y: 0, w: 1, h: 1, bleed: true, z: 0 };

/**
 * Renderer-neutral layout library. Every template scene references one of these
 * ids; switching aspect ratio re-resolves slots here (real reflow, not cropping).
 */
export const LAYOUTS: Record<string, LayoutDef> = {
  "title-center": {
    "16:9": {
      kicker: { x: 0.1, y: 0.26, w: 0.8, h: 0.08, align: "center", valign: "end" },
      headline: { x: 0.08, y: 0.35, w: 0.84, h: 0.26, align: "center" },
      subhead: { x: 0.15, y: 0.63, w: 0.7, h: 0.13, align: "center", valign: "start" },
      media: { x: 0.4, y: 0.06, w: 0.2, h: 0.18, align: "center" },
      decor: full,
    },
    "9:16": {
      kicker: { x: 0.06, y: 0.3, w: 0.88, h: 0.05, align: "center", valign: "end" },
      headline: { x: 0.06, y: 0.36, w: 0.88, h: 0.2, align: "center" },
      subhead: { x: 0.08, y: 0.58, w: 0.84, h: 0.12, align: "center", valign: "start" },
      media: { x: 0.3, y: 0.14, w: 0.4, h: 0.13, align: "center" },
      decor: full,
    },
    "1:1": {
      kicker: { x: 0.08, y: 0.24, w: 0.84, h: 0.07, align: "center", valign: "end" },
      headline: { x: 0.06, y: 0.33, w: 0.88, h: 0.26, align: "center" },
      subhead: { x: 0.1, y: 0.62, w: 0.8, h: 0.14, align: "center", valign: "start" },
      media: { x: 0.38, y: 0.06, w: 0.24, h: 0.16, align: "center" },
      decor: full,
    },
  },
  "hero-split": {
    "16:9": {
      kicker: { x: 0.02, y: 0.22, w: 0.44, h: 0.07, align: "start", valign: "end" },
      headline: { x: 0.02, y: 0.3, w: 0.44, h: 0.3, align: "start" },
      subhead: { x: 0.02, y: 0.62, w: 0.42, h: 0.18, align: "start", valign: "start" },
      media: { x: 0.5, y: 0.1, w: 0.48, h: 0.8, align: "center" },
      decor: full,
    },
    "9:16": {
      kicker: { x: 0.04, y: 0.08, w: 0.92, h: 0.04, align: "center", valign: "end" },
      headline: { x: 0.04, y: 0.13, w: 0.92, h: 0.17, align: "center" },
      subhead: { x: 0.06, y: 0.31, w: 0.88, h: 0.1, align: "center", valign: "start" },
      media: { x: 0.04, y: 0.44, w: 0.92, h: 0.5, align: "center" },
      decor: full,
    },
    "1:1": {
      kicker: { x: 0.04, y: 0.05, w: 0.92, h: 0.06, align: "center", valign: "end" },
      headline: { x: 0.04, y: 0.12, w: 0.92, h: 0.18, align: "center" },
      subhead: { x: 0.08, y: 0.3, w: 0.84, h: 0.09, align: "center", valign: "start" },
      media: { x: 0.12, y: 0.42, w: 0.76, h: 0.54, align: "center" },
      decor: full,
    },
  },
  "device-showcase": {
    "16:9": {
      headline: { x: 0.04, y: 0.02, w: 0.92, h: 0.14, align: "center" },
      media: { x: 0.14, y: 0.19, w: 0.72, h: 0.72, align: "center" },
      label: { x: 0.2, y: 0.9, w: 0.6, h: 0.08, align: "center" },
      decor: full,
    },
    "9:16": {
      headline: { x: 0.04, y: 0.06, w: 0.92, h: 0.14, align: "center" },
      media: { x: 0.02, y: 0.24, w: 0.96, h: 0.56, align: "center" },
      label: { x: 0.08, y: 0.82, w: 0.84, h: 0.07, align: "center" },
      decor: full,
    },
    "1:1": {
      headline: { x: 0.04, y: 0.03, w: 0.92, h: 0.14, align: "center" },
      media: { x: 0.08, y: 0.2, w: 0.84, h: 0.66, align: "center" },
      label: { x: 0.1, y: 0.87, w: 0.8, h: 0.09, align: "center" },
      decor: full,
    },
  },
  "benefit-list": {
    "16:9": {
      headline: { x: 0.02, y: 0.06, w: 0.5, h: 0.2, align: "start" },
      item1: { x: 0.02, y: 0.32, w: 0.5, h: 0.17, align: "start" },
      item2: { x: 0.02, y: 0.52, w: 0.5, h: 0.17, align: "start" },
      item3: { x: 0.02, y: 0.72, w: 0.5, h: 0.17, align: "start" },
      media: { x: 0.56, y: 0.12, w: 0.42, h: 0.76, align: "center" },
      decor: full,
    },
    "9:16": {
      headline: { x: 0.04, y: 0.05, w: 0.92, h: 0.1, align: "start" },
      item1: { x: 0.04, y: 0.17, w: 0.92, h: 0.08, align: "start" },
      item2: { x: 0.04, y: 0.26, w: 0.92, h: 0.08, align: "start" },
      item3: { x: 0.04, y: 0.35, w: 0.92, h: 0.08, align: "start" },
      media: { x: 0.04, y: 0.46, w: 0.92, h: 0.5, align: "center" },
      decor: full,
    },
    "1:1": {
      headline: { x: 0.04, y: 0.04, w: 0.92, h: 0.12, align: "start" },
      item1: { x: 0.04, y: 0.18, w: 0.52, h: 0.2, align: "start" },
      item2: { x: 0.04, y: 0.4, w: 0.52, h: 0.2, align: "start" },
      item3: { x: 0.04, y: 0.62, w: 0.52, h: 0.2, align: "start" },
      media: { x: 0.58, y: 0.2, w: 0.4, h: 0.62, align: "center" },
      decor: full,
    },
  },
  "stat-focus": {
    "16:9": {
      stat: { x: 0.05, y: 0.18, w: 0.9, h: 0.38, align: "center" },
      headline: { x: 0.1, y: 0.58, w: 0.8, h: 0.14, align: "center", valign: "start" },
      label: { x: 0.2, y: 0.76, w: 0.6, h: 0.08, align: "center", valign: "start" },
      decor: full,
    },
    "9:16": {
      stat: { x: 0.04, y: 0.28, w: 0.92, h: 0.2, align: "center" },
      headline: { x: 0.06, y: 0.5, w: 0.88, h: 0.12, align: "center", valign: "start" },
      label: { x: 0.08, y: 0.64, w: 0.84, h: 0.06, align: "center", valign: "start" },
      decor: full,
    },
    "1:1": {
      stat: { x: 0.04, y: 0.2, w: 0.92, h: 0.32, align: "center" },
      headline: { x: 0.08, y: 0.55, w: 0.84, h: 0.16, align: "center", valign: "start" },
      label: { x: 0.12, y: 0.74, w: 0.76, h: 0.08, align: "center", valign: "start" },
      decor: full,
    },
  },
  quote: {
    "16:9": {
      quote: { x: 0.08, y: 0.18, w: 0.84, h: 0.46, align: "center" },
      label: { x: 0.2, y: 0.68, w: 0.6, h: 0.1, align: "center", valign: "start" },
      media: { x: 0.44, y: 0.02, w: 0.12, h: 0.14, align: "center" },
      decor: full,
    },
    "9:16": {
      quote: { x: 0.05, y: 0.26, w: 0.9, h: 0.34, align: "center" },
      label: { x: 0.1, y: 0.62, w: 0.8, h: 0.07, align: "center", valign: "start" },
      media: { x: 0.36, y: 0.14, w: 0.28, h: 0.1, align: "center" },
      decor: full,
    },
    "1:1": {
      quote: { x: 0.06, y: 0.2, w: 0.88, h: 0.44, align: "center" },
      label: { x: 0.14, y: 0.68, w: 0.72, h: 0.1, align: "center", valign: "start" },
      media: { x: 0.42, y: 0.04, w: 0.16, h: 0.13, align: "center" },
      decor: full,
    },
  },
  "end-card": {
    "16:9": {
      media: { x: 0.35, y: 0.12, w: 0.3, h: 0.26, align: "center" },
      headline: { x: 0.08, y: 0.42, w: 0.84, h: 0.18, align: "center" },
      cta: { x: 0.25, y: 0.64, w: 0.5, h: 0.12, align: "center" },
      label: { x: 0.2, y: 0.8, w: 0.6, h: 0.08, align: "center", valign: "start" },
      decor: full,
    },
    "9:16": {
      media: { x: 0.2, y: 0.2, w: 0.6, h: 0.14, align: "center" },
      headline: { x: 0.05, y: 0.37, w: 0.9, h: 0.14, align: "center" },
      cta: { x: 0.12, y: 0.54, w: 0.76, h: 0.07, align: "center" },
      label: { x: 0.08, y: 0.63, w: 0.84, h: 0.05, align: "center", valign: "start" },
      decor: full,
    },
    "1:1": {
      media: { x: 0.3, y: 0.08, w: 0.4, h: 0.22, align: "center" },
      headline: { x: 0.06, y: 0.34, w: 0.88, h: 0.2, align: "center" },
      cta: { x: 0.2, y: 0.58, w: 0.6, h: 0.12, align: "center" },
      label: { x: 0.12, y: 0.74, w: 0.76, h: 0.08, align: "center", valign: "start" },
      decor: full,
    },
  },
  kinetic: {
    "16:9": {
      kicker: { x: 0.04, y: 0.2, w: 0.92, h: 0.1, align: "center", valign: "end" },
      headline: { x: 0.02, y: 0.3, w: 0.96, h: 0.4, align: "center" },
      subhead: { x: 0.1, y: 0.72, w: 0.8, h: 0.1, align: "center", valign: "start" },
      decor: full,
    },
    "9:16": {
      kicker: { x: 0.04, y: 0.28, w: 0.92, h: 0.06, align: "center", valign: "end" },
      headline: { x: 0.03, y: 0.35, w: 0.94, h: 0.28, align: "center" },
      subhead: { x: 0.06, y: 0.65, w: 0.88, h: 0.07, align: "center", valign: "start" },
      decor: full,
    },
    "1:1": {
      kicker: { x: 0.04, y: 0.2, w: 0.92, h: 0.09, align: "center", valign: "end" },
      headline: { x: 0.02, y: 0.3, w: 0.96, h: 0.38, align: "center" },
      subhead: { x: 0.08, y: 0.7, w: 0.84, h: 0.1, align: "center", valign: "start" },
      decor: full,
    },
  },
  "fullbleed-media": {
    "16:9": {
      media: full,
      headline: { x: 0.02, y: 0.66, w: 0.7, h: 0.18, align: "start", valign: "end" },
      subhead: { x: 0.02, y: 0.85, w: 0.6, h: 0.1, align: "start", valign: "start" },
      label: { x: 0.02, y: 0.02, w: 0.5, h: 0.08, align: "start" },
      decor: full,
    },
    "9:16": {
      media: full,
      headline: { x: 0.04, y: 0.6, w: 0.92, h: 0.14, align: "start", valign: "end" },
      subhead: { x: 0.04, y: 0.75, w: 0.92, h: 0.08, align: "start", valign: "start" },
      label: { x: 0.04, y: 0.04, w: 0.92, h: 0.05, align: "start" },
      decor: full,
    },
    "1:1": {
      media: full,
      headline: { x: 0.04, y: 0.62, w: 0.9, h: 0.18, align: "start", valign: "end" },
      subhead: { x: 0.04, y: 0.81, w: 0.9, h: 0.1, align: "start", valign: "start" },
      label: { x: 0.04, y: 0.04, w: 0.7, h: 0.08, align: "start" },
      decor: full,
    },
  },
  "media-grid": {
    "16:9": {
      media: { x: 0.02, y: 0.08, w: 0.3, h: 0.4 },
      media2: { x: 0.35, y: 0.08, w: 0.3, h: 0.4 },
      media3: { x: 0.68, y: 0.08, w: 0.3, h: 0.4 },
      media4: { x: 0.02, y: 0.52, w: 0.3, h: 0.4 },
      media5: { x: 0.35, y: 0.52, w: 0.3, h: 0.4 },
      media6: { x: 0.68, y: 0.52, w: 0.3, h: 0.4 },
      headline: { x: 0.1, y: 0.38, w: 0.8, h: 0.24, align: "center", z: 5 },
      decor: full,
    },
    "9:16": {
      media: { x: 0.04, y: 0.04, w: 0.44, h: 0.28 },
      media2: { x: 0.52, y: 0.04, w: 0.44, h: 0.28 },
      media3: { x: 0.04, y: 0.36, w: 0.44, h: 0.28 },
      media4: { x: 0.52, y: 0.36, w: 0.44, h: 0.28 },
      media5: { x: 0.04, y: 0.68, w: 0.44, h: 0.28 },
      media6: { x: 0.52, y: 0.68, w: 0.44, h: 0.28 },
      headline: { x: 0.04, y: 0.42, w: 0.92, h: 0.16, align: "center", z: 5 },
      decor: full,
    },
    "1:1": {
      media: { x: 0.02, y: 0.04, w: 0.3, h: 0.44 },
      media2: { x: 0.35, y: 0.04, w: 0.3, h: 0.44 },
      media3: { x: 0.68, y: 0.04, w: 0.3, h: 0.44 },
      media4: { x: 0.02, y: 0.52, w: 0.3, h: 0.44 },
      media5: { x: 0.35, y: 0.52, w: 0.3, h: 0.44 },
      media6: { x: 0.68, y: 0.52, w: 0.3, h: 0.44 },
      headline: { x: 0.06, y: 0.38, w: 0.88, h: 0.24, align: "center", z: 5 },
      decor: full,
    },
  },
  "character-stage": {
    "16:9": {
      media: { x: 0.3, y: 0.18, w: 0.4, h: 0.72, align: "center", valign: "end" },
      prop: { x: 0.02, y: 0.4, w: 0.24, h: 0.46, align: "center", valign: "end" },
      prop2: { x: 0.74, y: 0.4, w: 0.24, h: 0.46, align: "center", valign: "end" },
      headline: { x: 0.05, y: 0.02, w: 0.9, h: 0.14, align: "center" },
      label: { x: 0.2, y: 0.9, w: 0.6, h: 0.08, align: "center" },
      decor: full,
    },
    "9:16": {
      media: { x: 0.1, y: 0.3, w: 0.8, h: 0.5, align: "center", valign: "end" },
      prop: { x: 0.02, y: 0.72, w: 0.3, h: 0.2, align: "center", valign: "end" },
      prop2: { x: 0.68, y: 0.72, w: 0.3, h: 0.2, align: "center", valign: "end" },
      headline: { x: 0.04, y: 0.1, w: 0.92, h: 0.14, align: "center" },
      label: { x: 0.08, y: 0.84, w: 0.84, h: 0.06, align: "center" },
      decor: full,
    },
    "1:1": {
      media: { x: 0.25, y: 0.2, w: 0.5, h: 0.66, align: "center", valign: "end" },
      prop: { x: 0.02, y: 0.5, w: 0.22, h: 0.36, align: "center", valign: "end" },
      prop2: { x: 0.76, y: 0.5, w: 0.22, h: 0.36, align: "center", valign: "end" },
      headline: { x: 0.04, y: 0.03, w: 0.92, h: 0.15, align: "center" },
      label: { x: 0.12, y: 0.88, w: 0.76, h: 0.09, align: "center" },
      decor: full,
    },
  },
  "presenter-full": {
    "16:9": {
      presenter: full,
      overlay: { x: 0.56, y: 0.12, w: 0.42, h: 0.46, align: "center" },
      label: { x: 0.02, y: 0.62, w: 0.46, h: 0.14, align: "start" },
      headline: { x: 0.02, y: 0.06, w: 0.6, h: 0.16, align: "start" },
      decor: full,
    },
    "9:16": {
      presenter: full,
      overlay: { x: 0.08, y: 0.1, w: 0.84, h: 0.3, align: "center" },
      label: { x: 0.04, y: 0.56, w: 0.92, h: 0.08, align: "center" },
      headline: { x: 0.04, y: 0.04, w: 0.92, h: 0.1, align: "center" },
      decor: full,
    },
    "1:1": {
      presenter: full,
      overlay: { x: 0.52, y: 0.08, w: 0.46, h: 0.4, align: "center" },
      label: { x: 0.04, y: 0.6, w: 0.6, h: 0.12, align: "start" },
      headline: { x: 0.04, y: 0.04, w: 0.7, h: 0.14, align: "start" },
      decor: full,
    },
  },
  "presenter-split": {
    "16:9": {
      presenter: { x: 0.5, y: 0, w: 0.5, h: 1, bleed: true, z: 1 },
      overlay: { x: 0.02, y: 0.14, w: 0.44, h: 0.56, align: "center" },
      headline: { x: 0.02, y: 0.02, w: 0.44, h: 0.12, align: "start" },
      label: { x: 0.02, y: 0.74, w: 0.44, h: 0.16, align: "start" },
      decor: full,
    },
    "9:16": {
      presenter: { x: 0, y: 0.5, w: 1, h: 0.5, bleed: true, z: 1 },
      overlay: { x: 0.06, y: 0.1, w: 0.88, h: 0.28, align: "center" },
      headline: { x: 0.04, y: 0.02, w: 0.92, h: 0.07, align: "center" },
      label: { x: 0.04, y: 0.39, w: 0.92, h: 0.07, align: "center" },
      decor: full,
    },
    "1:1": {
      presenter: { x: 0.5, y: 0, w: 0.5, h: 1, bleed: true, z: 1 },
      overlay: { x: 0.02, y: 0.16, w: 0.44, h: 0.5, align: "center" },
      headline: { x: 0.02, y: 0.02, w: 0.44, h: 0.13, align: "start" },
      label: { x: 0.02, y: 0.7, w: 0.44, h: 0.2, align: "start" },
      decor: full,
    },
  },
  "presenter-inset": {
    "16:9": {
      presenter: { x: 0.66, y: 0.52, w: 0.32, h: 0.44, z: 3 },
      overlay: { x: 0.02, y: 0.2, w: 0.6, h: 0.7, align: "center" },
      headline: { x: 0.02, y: 0.02, w: 0.9, h: 0.16, align: "start" },
      label: { x: 0.66, y: 0.2, w: 0.32, h: 0.28, align: "start" },
      decor: full,
    },
    "9:16": {
      presenter: { x: 0.52, y: 0.72, w: 0.44, h: 0.24, z: 3 },
      overlay: { x: 0.04, y: 0.16, w: 0.92, h: 0.5, align: "center" },
      headline: { x: 0.04, y: 0.04, w: 0.92, h: 0.1, align: "start" },
      label: { x: 0.04, y: 0.72, w: 0.44, h: 0.2, align: "start" },
      decor: full,
    },
    "1:1": {
      presenter: { x: 0.64, y: 0.62, w: 0.34, h: 0.34, z: 3 },
      overlay: { x: 0.02, y: 0.18, w: 0.6, h: 0.76, align: "center" },
      headline: { x: 0.02, y: 0.02, w: 0.94, h: 0.14, align: "start" },
      label: { x: 0.64, y: 0.2, w: 0.34, h: 0.38, align: "start" },
      decor: full,
    },
  },
  /** Full-screen whiteboard illustration; the presenter is off screen but still heard. */
  whiteboard: {
    "16:9": {
      headline: { x: 0.06, y: 0.05, w: 0.88, h: 0.14, align: "center" },
      overlay: { x: 0.08, y: 0.2, w: 0.84, h: 0.6, align: "center" },
      label: { x: 0.1, y: 0.8, w: 0.8, h: 0.09, align: "center" },
      decor: full,
    },
    "9:16": {
      headline: { x: 0.04, y: 0.05, w: 0.92, h: 0.12, align: "center" },
      overlay: { x: 0.04, y: 0.2, w: 0.92, h: 0.46, align: "center" },
      label: { x: 0.06, y: 0.66, w: 0.88, h: 0.08, align: "center" },
      decor: full,
    },
    "1:1": {
      headline: { x: 0.04, y: 0.04, w: 0.92, h: 0.14, align: "center" },
      overlay: { x: 0.06, y: 0.2, w: 0.88, h: 0.56, align: "center" },
      label: { x: 0.06, y: 0.77, w: 0.88, h: 0.08, align: "center" },
      decor: full,
    },
  },
  /** Course opening: full-frame presenter with a large lower title card. */
  "lesson-intro": {
    "16:9": {
      presenter: full,
      kicker: { x: 0.05, y: 0.6, w: 0.5, h: 0.06, align: "start", valign: "end" },
      headline: { x: 0.05, y: 0.67, w: 0.62, h: 0.2, align: "start", valign: "start" },
      decor: full,
    },
    "9:16": {
      presenter: full,
      kicker: { x: 0.06, y: 0.52, w: 0.88, h: 0.04, align: "start", valign: "end" },
      headline: { x: 0.06, y: 0.57, w: 0.88, h: 0.14, align: "start", valign: "start" },
      decor: full,
    },
    "1:1": {
      presenter: full,
      kicker: { x: 0.05, y: 0.58, w: 0.7, h: 0.06, align: "start", valign: "end" },
      headline: { x: 0.05, y: 0.65, w: 0.8, h: 0.18, align: "start", valign: "start" },
      decor: full,
    },
  },
  /** Course lesson body: large concise takeaway with a rounded presenter crop. */
  "lesson-takeaway": {
    "16:9": {
      presenter: { x: 0.6, y: 0.16, w: 0.36, h: 0.68, z: 3 },
      kicker: { x: 0.05, y: 0.18, w: 0.5, h: 0.07, align: "start", valign: "end" },
      headline: { x: 0.05, y: 0.27, w: 0.52, h: 0.4, align: "start", valign: "start" },
      overlay: { x: 0.05, y: 0.62, w: 0.5, h: 0.24, align: "start" },
      decor: full,
    },
    "9:16": {
      presenter: { x: 0.14, y: 0.5, w: 0.72, h: 0.34, z: 3 },
      kicker: { x: 0.06, y: 0.1, w: 0.88, h: 0.04, align: "start", valign: "end" },
      headline: { x: 0.06, y: 0.15, w: 0.88, h: 0.24, align: "start", valign: "start" },
      overlay: { x: 0.06, y: 0.39, w: 0.88, h: 0.1, align: "start" },
      decor: full,
    },
    "1:1": {
      presenter: { x: 0.56, y: 0.2, w: 0.4, h: 0.56, z: 3 },
      kicker: { x: 0.05, y: 0.2, w: 0.48, h: 0.07, align: "start", valign: "end" },
      headline: { x: 0.05, y: 0.28, w: 0.48, h: 0.4, align: "start", valign: "start" },
      overlay: { x: 0.05, y: 0.66, w: 0.48, h: 0.2, align: "start" },
      decor: full,
    },
  },
  lyric: {
    "16:9": {
      headline: { x: 0.06, y: 0.34, w: 0.88, h: 0.32, align: "center" },
      kicker: { x: 0.2, y: 0.2, w: 0.6, h: 0.1, align: "center", valign: "end" },
      media: { x: 0.35, y: 0.66, w: 0.3, h: 0.3, align: "center" },
      decor: full,
    },
    "9:16": {
      headline: { x: 0.04, y: 0.36, w: 0.92, h: 0.24, align: "center" },
      kicker: { x: 0.1, y: 0.28, w: 0.8, h: 0.06, align: "center", valign: "end" },
      media: { x: 0.25, y: 0.64, w: 0.5, h: 0.2, align: "center" },
      decor: full,
    },
    "1:1": {
      headline: { x: 0.05, y: 0.32, w: 0.9, h: 0.3, align: "center" },
      kicker: { x: 0.15, y: 0.2, w: 0.7, h: 0.09, align: "center", valign: "end" },
      media: { x: 0.33, y: 0.66, w: 0.34, h: 0.3, align: "center" },
      decor: full,
    },
  },
};

export function resolveSlot(layout: string, aspect: AspectRatio, slot: string): SlotBox | undefined {
  return LAYOUTS[layout]?.[aspect]?.[slot];
}

export const LAYOUT_IDS = Object.keys(LAYOUTS);
