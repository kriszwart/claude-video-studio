/**
 * Versioned graphics component catalog (FR-19). Parameters are plain project data,
 * edited through the normal inspector; the canvas never owns editing state.
 */
export interface ComponentParam {
  name: string;
  kind: "number" | "text" | "color" | "asset" | "boolean" | "select";
  default: number | string | boolean;
  min?: number;
  max?: number;
  options?: string[];
  label: string;
}

export interface ComponentDef {
  id: string;
  version: number;
  backend: "skia" | "redraw";
  name: string;
  description: string;
  params: ComponentParam[];
  /** Honest capability notes shown to users (e.g. what a glass/backing effect can sample). */
  notes: string[];
  seekable: true;
}

export const COMPONENTS: ComponentDef[] = [
  {
    id: "path-diagram",
    version: 1,
    backend: "skia",
    name: "Path-drawn diagram",
    description: "Sequential steps drawn as boxes with arrows; each step reveals in turn.",
    params: [
      { name: "steps", kind: "text", default: "Plan|Build|Ship", label: "Steps (separate with |)" },
      { name: "color", kind: "color", default: "#1f2937", label: "Line colour" },
      { name: "accent", kind: "color", default: "#f59e0b", label: "Final step colour" },
      { name: "ink", kind: "color", default: "#111827", label: "Label colour" },
      { name: "strokeWidth", kind: "number", default: 6, min: 1, max: 24, label: "Stroke width" },
      { name: "stepSec", kind: "number", default: 1.6, min: 0.3, max: 10, label: "Seconds per step" },
      { name: "wobble", kind: "number", default: 0.6, min: 0, max: 3, label: "Hand-drawn wobble" },
    ],
    notes: ["Drawn on a transparent canvas above the scene background."],
    seekable: true,
  },
  {
    id: "mask-reveal",
    version: 1,
    backend: "skia",
    name: "Masked product-image reveal",
    description: "Reveals the supplied image, unchanged, from a close-up circle to the full product.",
    params: [
      { name: "image", kind: "asset", default: "", label: "Product image" },
      { name: "focalX", kind: "number", default: 0.5, min: 0, max: 1, label: "Close-up X" },
      { name: "focalY", kind: "number", default: 0.5, min: 0, max: 1, label: "Close-up Y" },
      { name: "zoom", kind: "number", default: 2.2, min: 1, max: 5, label: "Close-up zoom" },
      { name: "revealSec", kind: "number", default: 2.2, min: 0.3, max: 10, label: "Reveal seconds" },
      { name: "corner", kind: "number", default: 28, min: 0, max: 120, label: "Corner radius" },
    ],
    notes: ["The image pixels are not altered; only scale and mask change."],
    seekable: true,
  },
  {
    id: "type-overlay",
    version: 1,
    backend: "skia",
    name: "Typographic annotation",
    description: "A takeaway or annotation with an accent underline that draws on.",
    params: [
      { name: "text", kind: "text", default: "Key takeaway", label: "Text" },
      { name: "color", kind: "color", default: "#ffffff", label: "Text colour" },
      { name: "accent", kind: "color", default: "#f59e0b", label: "Underline colour" },
      { name: "size", kind: "number", default: 72, min: 16, max: 200, label: "Size (px at 1080p)" },
      { name: "revealSec", kind: "number", default: 0.9, min: 0.1, max: 5, label: "Reveal seconds" },
    ],
    notes: ["Text in this component is also kept in project data for accessibility and editing."],
    seekable: true,
  },
  {
    id: "ribbon",
    version: 1,
    backend: "redraw",
    name: "Variable-width ribbon",
    description: "A GPU ribbon whose width and colour change along its path; draws on over time.",
    params: [
      { name: "path", kind: "select", default: "wave", options: ["wave", "loop", "swoosh", "circle"], label: "Path shape" },
      { name: "colors", kind: "text", default: "#3FCEBC,#5F96E7,#DE589F,#FAEC54", label: "Gradient colours (comma separated)" },
      { name: "width", kind: "number", default: 60, min: 4, max: 200, label: "Base width" },
      { name: "drawSec", kind: "number", default: 1.6, min: 0.2, max: 10, label: "Draw-on seconds" },
      { name: "glow", kind: "number", default: 24, min: 0, max: 120, label: "Glow softness" },
    ],
    notes: ["Rendered with WebGPU; requires a worker that reports Redraw support."],
    seekable: true,
  },
  {
    id: "glow-backing",
    version: 1,
    backend: "redraw",
    name: "Feathered glow backing",
    description: "A soft glowing panel behind labels and titles.",
    params: [
      { name: "color", kind: "color", default: "#111827", label: "Panel colour" },
      { name: "glowColor", kind: "color", default: "#8b8fff", label: "Glow colour" },
      { name: "feather", kind: "number", default: 32, min: 0, max: 160, label: "Feather" },
      { name: "opacity", kind: "number", default: 0.92, min: 0.3, max: 1, label: "Panel opacity" },
    ],
    notes: [
      "This effect cannot sample or blur the video/DOM layers behind it: it is an opaque-to-translucent panel with a feathered glow, tested for readability, not a real backdrop blur.",
    ],
    seekable: true,
  },
  {
    id: "color-sweep",
    version: 1,
    backend: "redraw",
    name: "Geometry colour sweep",
    description: "A sweeping colour band across concentric geometry, for music accents and logo reveals.",
    params: [
      { name: "colors", kind: "text", default: "#8b8fff,#22d3ee,#f59e0b", label: "Colours" },
      { name: "rings", kind: "number", default: 5, min: 1, max: 12, label: "Rings" },
      { name: "sweepSec", kind: "number", default: 2, min: 0.2, max: 10, label: "Sweep seconds" },
    ],
    notes: ["Rendered with WebGPU; requires a worker that reports Redraw support."],
    seekable: true,
  },
];

export function findComponent(id: string, version: number) {
  return COMPONENTS.find((c) => c.id === id && c.version === version);
}

export function defaultParams(def: ComponentDef): Record<string, number | string | boolean> {
  return Object.fromEntries(def.params.map((p) => [p.name, p.default]));
}
