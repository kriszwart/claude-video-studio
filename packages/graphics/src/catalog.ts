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
  backend: "skia" | "redraw" | "three";
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
    id: "sketch",
    version: 1,
    backend: "skia",
    name: "Whiteboard sketch",
    description: "Hand-drawn line illustrations (chosen by keyword from a built-in set) drawn on stroke by stroke, with handwritten-style labels.",
    params: [
      { name: "items", kind: "text", default: "idea", label: "Illustrations (keywords, separate with |)" },
      { name: "labels", kind: "text", default: "", label: "Labels (separate with |)" },
      { name: "ink", kind: "color", default: "#1f2937", label: "Marker colour" },
      { name: "accent", kind: "color", default: "#f59e0b", label: "Highlight colour" },
      { name: "drawSec", kind: "number", default: 1.6, min: 0.4, max: 10, label: "Seconds per drawing" },
    ],
    notes: ["Icons are a small original line-art set matched by keyword; unmatched keywords use a light-bulb sketch. They illustrate, they do not depict your real product."],
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
    id: "platonic-morph",
    version: 1,
    backend: "skia",
    name: "Platonic morph",
    description: "A lit, slowly turning 3D platonic solid that mutates through a sequence: each solid inflates into a sphere and the next one grows out of it.",
    params: [
      { name: "sequence", kind: "text", default: "tetrahedron,cube,octahedron,dodecahedron,icosahedron", label: "Solids in order (separate with ,)" },
      { name: "holdSec", kind: "number", default: 1.6, min: 0.2, max: 10, label: "Seconds each solid holds" },
      { name: "morphSec", kind: "number", default: 1.4, min: 0.2, max: 10, label: "Seconds per mutation" },
      { name: "colors", kind: "text", default: "#8b5cf6,#ec4899,#fb7a5a", label: "Face colours (hex, separate with ,)" },
      { name: "edgeColor", kind: "color", default: "#ffffff", label: "Edge colour" },
      { name: "edges", kind: "boolean", default: true, label: "Show edges" },
      { name: "spin", kind: "number", default: 0.35, min: 0, max: 3, label: "Spin speed" },
      // Not "size": the compiler scales a "size" param as pixels at 1080p.
      { name: "fill", kind: "number", default: 0.62, min: 0.2, max: 1.2, label: "Size (share of the box)" },
      { name: "glow", kind: "boolean", default: true, label: "Glow and floor shadow" },
      { name: "detail", kind: "number", default: 2, min: 1, max: 3, label: "Smoothness of the sphere stage" },
    ],
    notes: ["Rendered in 3D on the CPU (Skia): exact and repeatable on every render."],
    seekable: true,
  },
  {
    id: "mesh-gradient",
    version: 1,
    backend: "skia",
    name: "Mesh gradient (shader)",
    description: "A living background: four colours drift on slow orbits and blend into one soft, flowing gradient.",
    params: [
      { name: "colors", kind: "text", default: "#8b5cf6,#ec4899,#fb7a5a,#38bdf8", label: "Colours (hex, up to four, separate with ,)" },
      { name: "speed", kind: "number", default: 0.25, min: 0, max: 3, label: "Speed" },
      { name: "softness", kind: "number", default: 1.6, min: 0.5, max: 4, label: "Edge between colours (higher is sharper)" },
      { name: "warp", kind: "number", default: 0.4, min: 0, max: 1, label: "Swirl" },
    ],
    notes: ["Skia shader (SkSL) drawn on the GPU through WebGL: a pure function of time, so each frame is exact and repeatable on the same machine; a different GPU can differ by a shade.", "Fills its box: use it full-frame behind text."],
    seekable: true,
  },
  {
    id: "aurora",
    version: 1,
    backend: "skia",
    name: "Silk aurora (shader)",
    description: "Folded, silky bands of light in your colours, flowing slowly over a dark base.",
    params: [
      { name: "colors", kind: "text", default: "#8b5cf6,#ec4899,#fb7a5a,#38bdf8", label: "Colours (hex, up to four, separate with ,)" },
      { name: "base", kind: "color", default: "#0b0a14", label: "Base colour" },
      { name: "speed", kind: "number", default: 1, min: 0, max: 4, label: "Speed" },
      { name: "scale", kind: "number", default: 1.6, min: 0.5, max: 8, label: "Scale of the folds" },
      { name: "intensity", kind: "number", default: 1, min: 0, max: 2, label: "Brightness of the light" },
    ],
    notes: ["Skia shader (SkSL) drawn on the GPU through WebGL: a pure function of time, so each frame is exact and repeatable on the same machine; a different GPU can differ by a shade.", "Fills its box: use it full-frame behind text."],
    seekable: true,
  },
  {
    id: "metaballs",
    version: 1,
    backend: "skia",
    name: "Gooey metaballs (shader)",
    description: "Glossy blobs in your colours drift, merge and split apart, lit like liquid.",
    params: [
      { name: "count", kind: "number", default: 6, min: 1, max: 8, label: "Blobs" },
      { name: "colors", kind: "text", default: "#8b5cf6,#ec4899,#fb7a5a,#38bdf8", label: "Colours (hex, up to four, separate with ,)" },
      { name: "speed", kind: "number", default: 0.5, min: 0, max: 3, label: "Speed" },
      { name: "fill", kind: "number", default: 0.7, min: 0.2, max: 1.2, label: "Spread (share of the box)" },
      { name: "gloss", kind: "number", default: 0.8, min: 0, max: 2, label: "Gloss" },
    ],
    notes: ["Skia shader (SkSL) drawn on the GPU through WebGL: a pure function of time, so each frame is exact and repeatable on the same machine; a different GPU can differ by a shade.", "Transparent around the blobs: the scene shows through."],
    seekable: true,
  },
  {
    id: "liquid-morph",
    version: 1,
    backend: "skia",
    name: "Liquid shape morph (shader)",
    description: "A glossy liquid shape that melts from one form into the next: circle, squircle, star, heart, triangle, ring or blob.",
    params: [
      { name: "sequence", kind: "text", default: "circle,squircle,star,heart", label: "Shapes in order (circle, squircle, star, heart, triangle, ring, blob)" },
      { name: "holdSec", kind: "number", default: 1.2, min: 0.1, max: 10, label: "Seconds each shape holds" },
      { name: "morphSec", kind: "number", default: 1, min: 0.1, max: 10, label: "Seconds per melt" },
      { name: "colors", kind: "text", default: "#8b5cf6,#ec4899,#fb7a5a,#38bdf8", label: "Colours (hex, up to four, separate with ,)" },
      // Not "size": the compiler scales a "size" param as pixels at 1080p.
      { name: "fill", kind: "number", default: 0.62, min: 0.2, max: 1.2, label: "Size (share of the box)" },
      { name: "wobble", kind: "number", default: 1, min: 0, max: 3, label: "Ripple while melting" },
      { name: "gloss", kind: "number", default: 0.9, min: 0, max: 2, label: "Gloss" },
      { name: "glow", kind: "boolean", default: true, label: "Soft glow" },
    ],
    notes: ["Skia shader (SkSL) drawn on the GPU through WebGL: a pure function of time, so each frame is exact and repeatable on the same machine; a different GPU can differ by a shade.", "Transparent around the shape: the scene shows through."],
    seekable: true,
  },
  {
    id: "glass-lens",
    version: 1,
    backend: "skia",
    name: "Glass lens over an image (shader)",
    description: "A refracting, magnifying glass lens glides over your image (a product shot or screenshot), with a bright rim and a soft shadow.",
    params: [
      { name: "image", kind: "asset", default: "", label: "Image" },
      { name: "path", kind: "select", default: "drift", options: ["drift", "sweep", "focus"], label: "Lens movement (focus settles on the close-up point)" },
      { name: "lensSize", kind: "number", default: 0.26, min: 0.05, max: 0.6, label: "Lens size (share of the box)" },
      { name: "magnify", kind: "number", default: 1.6, min: 1, max: 4, label: "Magnification" },
      { name: "refraction", kind: "number", default: 0.5, min: 0, max: 1.5, label: "Refraction at the rim" },
      { name: "chroma", kind: "number", default: 0.35, min: 0, max: 3, label: "Colour fringing" },
      { name: "focalX", kind: "number", default: 0.5, min: 0, max: 1, label: "Close-up point X (focus)" },
      { name: "focalY", kind: "number", default: 0.5, min: 0, max: 1, label: "Close-up point Y (focus)" },
    ],
    notes: ["Skia shader (SkSL) drawn on the GPU through WebGL: a pure function of time, so each frame is exact and repeatable on the same machine; a different GPU can differ by a shade.", "The lens refracts the image you choose, not other layers behind it."],
    seekable: true,
  },
  {
    id: "platonic-shader",
    version: 1,
    backend: "three",
    name: "Platonic shader morph",
    description: "An iridescent, shader-lit platonic solid on the GPU: each solid melts into a rippling, twisting sphere and the next one grows out of it, with a glow shell and drifting particles.",
    params: [
      { name: "sequence", kind: "text", default: "tetrahedron,cube,octahedron,dodecahedron,icosahedron", label: "Solids in order (separate with ,)" },
      { name: "holdSec", kind: "number", default: 2, min: 0.2, max: 10, label: "Seconds each solid holds" },
      { name: "morphSec", kind: "number", default: 1.8, min: 0.2, max: 10, label: "Seconds per mutation" },
      { name: "colors", kind: "text", default: "#8b5cf6,#ec4899,#fb7a5a,#38bdf8", label: "Colours (hex, separate with ,)" },
      { name: "edgeColor", kind: "color", default: "#f5f3ff", label: "Edge colour" },
      { name: "edges", kind: "boolean", default: true, label: "Show edges" },
      { name: "mutation", kind: "number", default: 1, min: 0, max: 2, label: "Ripple and twist during a mutation" },
      { name: "iridescence", kind: "number", default: 1, min: 0, max: 2, label: "Iridescent sheen" },
      { name: "spin", kind: "number", default: 0.4, min: 0, max: 3, label: "Spin speed" },
      // Not "size": the compiler scales a "size" param as pixels at 1080p.
      { name: "fill", kind: "number", default: 0.6, min: 0.2, max: 1.2, label: "Size (share of the box)" },
      { name: "particles", kind: "number", default: 420, min: 0, max: 2000, label: "Particles" },
      { name: "detail", kind: "number", default: 3, min: 2, max: 4, label: "Mesh detail" },
      { name: "shadow", kind: "boolean", default: true, label: "Floor shadow" },
      { name: "minInflate", kind: "number", default: 0, min: 0, max: 1, label: "Keep it at least this round (1 = sphere)" },
      { name: "material", kind: "select", default: "iridescent", options: ["iridescent", "chrome", "xray"], label: "Material" },
      { name: "spikes", kind: "number", default: 0, min: 0, max: 1, label: "Crystal spikes on the beat" },
      { name: "glitch", kind: "number", default: 0, min: 0, max: 1, label: "Glitch snaps (share of beats)" },
      { name: "satellites", kind: "number", default: 0, min: 0, max: 1, label: "Five small solids orbiting (size)" },
      { name: "bpm", kind: "number", default: 0, min: 0, max: 240, label: "Pulse to tempo (BPM, 0 = off)" },
      { name: "beatOffsetSec", kind: "number", default: 0, min: 0, max: 600, label: "First beat (seconds into the video)" },
      { name: "pulse", kind: "number", default: 0.5, min: 0, max: 1, label: "Beat pulse strength" },
      { name: "colorCycleSec", kind: "number", default: 0, min: 0, max: 600, label: "Colour cycle seconds (0 = follow the sequence)" },
      { name: "morphOffsetSec", kind: "number", default: 0, min: -600, max: 600, label: "Start this far into the sequence (s)" },
      { name: "clockOffsetSec", kind: "number", default: 0, min: -600, max: 600, label: "Clock offset (s), to continue from an earlier scene" },
    ],
    notes: ["Rendered with three.js (WebGL) shaders; requires a worker that reports three.js support."],
    seekable: true,
  },
  {
    id: "footage-fx",
    version: 1,
    backend: "three",
    name: "Footage glitch FX",
    description: "Re-draws the scene's video through a GPU shader: chromatic split, beat-driven block glitches and line tearing, pixel-sort smears, liquid warp, mirror or kaleidoscope, thermal/acid/mono/duotone grades, invert strobes, scanlines and grain.",
    params: [
      { name: "video", kind: "text", default: "", label: "Video layer id in this scene (empty = the first video)" },
      { name: "grade", kind: "select", default: "none", options: ["none", "thermal", "acid", "mono", "duotone"], label: "Colour grade" },
      { name: "tint", kind: "color", default: "#ff4fd8", label: "Duotone colour" },
      { name: "rgbSplit", kind: "number", default: 0.5, min: 0, max: 2, label: "Chromatic split" },
      { name: "glitch", kind: "number", default: 0.3, min: 0, max: 1, label: "Glitch bursts (share of beats)" },
      { name: "glitchIn", kind: "number", default: 0.6, min: 0, max: 1, label: "Glitch on the cut in" },
      { name: "warp", kind: "number", default: 0.3, min: 0, max: 2, label: "Liquid warp" },
      { name: "sort", kind: "number", default: 0, min: 0, max: 2, label: "Pixel-sort smear" },
      { name: "mirror", kind: "select", default: "off", options: ["off", "left", "right"], label: "Mirror" },
      { name: "kaleido", kind: "number", default: 0, min: 0, max: 16, label: "Kaleidoscope segments (0 = off)" },
      { name: "strobe", kind: "number", default: 0, min: 0, max: 1, label: "Invert strobes on beats" },
      { name: "beatZoom", kind: "number", default: 0.04, min: 0, max: 0.5, label: "Zoom kick on beats" },
      { name: "zoomDrift", kind: "number", default: 0.06, min: -0.5, max: 0.5, label: "Slow zoom over the scene" },
      { name: "brightness", kind: "number", default: 1, min: 0, max: 2, label: "Brightness" },
      { name: "grain", kind: "number", default: 0.4, min: 0, max: 2, label: "Grain" },
      { name: "scanlines", kind: "number", default: 0.3, min: 0, max: 1, label: "Scanlines" },
      { name: "bpm", kind: "number", default: 0, min: 0, max: 240, label: "Tempo (BPM, 0 = no beat effects)" },
      { name: "beatOffsetSec", kind: "number", default: 0, min: 0, max: 600, label: "First beat (seconds into the video)" },
      { name: "clockOffsetSec", kind: "number", default: 0, min: -600, max: 600, label: "Clock offset (s): the scene's start in the video" },
      { name: "flash", kind: "text", default: "", label: "Snippet cut-ins: other video layer ids in this scene (separate with ,)" },
      { name: "flashRate", kind: "number", default: 0.25, min: 0, max: 1, label: "Cut-ins per 16th note (share)" },
      { name: "flashFrames", kind: "number", default: 2, min: 1, max: 4, label: "Frames per cut-in" },
      { name: "flashGrade", kind: "select", default: "none", options: ["none", "thermal", "acid", "mono", "duotone", "invert"], label: "Cut-in grade" },
    ],
    notes: ["Put it above the scene's video layer, full frame; the video itself stays the source of each frame."],
    seekable: true,
  },
  {
    id: "signal-overlay",
    version: 1,
    backend: "three",
    name: "Signal noise overlay",
    description: "A transparent top layer of grain, scanlines, a rolling bar, noise bands in glitch bursts and beat strobes, over everything including text.",
    params: [
      { name: "grain", kind: "number", default: 0.5, min: 0, max: 2, label: "Grain" },
      { name: "scanlines", kind: "number", default: 0.5, min: 0, max: 1, label: "Scanlines" },
      { name: "roll", kind: "number", default: 0.5, min: 0, max: 1, label: "Rolling bar" },
      { name: "glitch", kind: "number", default: 0.2, min: 0, max: 1, label: "Noise bands (share of beats)" },
      { name: "strobe", kind: "number", default: 0, min: 0, max: 1, label: "Strobe flashes on beats" },
      { name: "strobeColor", kind: "color", default: "#ffffff", label: "Strobe colour" },
      { name: "leaks", kind: "number", default: 0, min: 0, max: 1, label: "Light leaks" },
      { name: "leakColor", kind: "color", default: "#ff7a2f", label: "Leak colour" },
      { name: "leakColor2", kind: "color", default: "#ff2e88", label: "Second leak colour" },
      { name: "bpm", kind: "number", default: 0, min: 0, max: 240, label: "Tempo (BPM)" },
      { name: "beatOffsetSec", kind: "number", default: 0, min: 0, max: 600, label: "First beat (s)" },
      { name: "clockOffsetSec", kind: "number", default: 0, min: -600, max: 600, label: "Clock offset (s)" },
    ],
    notes: ["Flashes: keep strobes rare for viewers sensitive to flicker."],
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
