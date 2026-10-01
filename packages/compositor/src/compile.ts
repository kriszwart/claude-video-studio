import { characterSvg, characterTweens } from "./character";
import {
  computeTimeline,
  programSegments,
  sourceToOutput,
  dimensionsFor,
  resolveCaptions,
  SAFE_AREA_PRESETS,
  type Background,
  type BrandSnapshot,
  type ColorRef,
  type ImageLayer,
  type Layer,
  type ProjectDocument,
  type Scene,
  type ShapeLayer,
  type TextLayer,
  type Timeline,
  type VideoLayer,
} from "@vs/domain";
import { resolveSlot, type SlotBox } from "./layouts";

export interface StagedAsset {
  /** Path relative to the bundle root, e.g. "assets/ast_x.png". */
  file: string;
  kind: "image" | "svg" | "video" | "audio" | "font";
  width?: number;
  height?: number;
  durationSec?: number;
  hasAudio?: boolean;
  /** Mean luminance (0..1) of an image's opaque pixels, measured at ingest; picks a contrasting backing. */
  opaqueLuma?: number;
}

export interface StagedFont {
  family: string;
  weight: number;
  style?: "normal" | "italic";
  /** Path relative to bundle root. */
  file: string;
}

/** A graphics layer compiled by a backend adapter (section 27). */
export interface GraphicsFragment {
  html: string;
  /** Inline script registering this layer's spec (runs before the runtimes). */
  script?: string;
  /** Runtime scripts (bundle-relative), emitted once each after all layer specs. */
  scriptSrcs?: string[];
  files?: { path: string; source: string }[];
}

export interface GraphicsCompileInfo {
  sceneStartSec: number;
  sceneDurationSec: number;
  width: number;
  height: number;
  box: Box;
  brand: BrandSnapshot;
  fonts: StagedFont[];
  assetFile: (assetId: string) => string | undefined;
}

export interface CompileContext {
  /** 1 for final, e.g. 0.5 for drafts. Every size is relative so both share one layout. */
  scale: number;
  assets: ReadonlyMap<string, StagedAsset>;
  fonts: StagedFont[];
  /** Pre-mixed audio bed covering the full timeline. */
  audioMix?: { file: string };
  /** Compile a graphics layer; throw GraphicsUnavailableError when the backend cannot render. */
  graphics?: (layer: Extract<Layer, { kind: "graphics" }>, info: GraphicsCompileInfo) => GraphicsFragment;
  /** Relative path of the vendored GSAP build inside the bundle. */
  gsapFile: string;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CompiledBundle {
  html: string;
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  durationSec: number;
  timeline: Timeline;
  /** Extra files emitted by graphics adapters. */
  extraFiles: { path: string; source: string }[];
  /** Everything that determines the rendered pixels, for the bundle hash. */
  manifest: Record<string, unknown>;
  warnings: string[];
}

export class GraphicsUnavailableError extends Error {}

/** Film grain tile: deterministic fractal noise (fixed seed), drawn once and moved in steps. */
const GRAIN_SVG = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="3" seed="7" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>')}`;

const ROLE_SIZE: Record<TextLayer["role"], number> = {
  kicker: 34,
  headline: 104,
  subhead: 50,
  body: 40,
  label: 34,
  cta: 58,
  stat: 190,
  caption: 44,
  quote: 70,
};
const ROLE_FONT: Record<TextLayer["role"], "heading" | "body"> = {
  kicker: "body",
  headline: "heading",
  subhead: "body",
  body: "body",
  label: "body",
  cta: "heading",
  stat: "heading",
  caption: "body",
  quote: "heading",
};

export function resolveColor(brand: BrandSnapshot, ref: ColorRef | string | undefined, fallback: string): string {
  if (!ref) return fallback;
  if (ref.startsWith("brand.")) {
    const key = ref.slice(6) as keyof BrandSnapshot["colors"];
    return safeHex(brand.colors[key]) ?? fallback;
  }
  return safeHex(ref) ?? fallback;
}

function safeHex(v: string | undefined): string | undefined {
  return v && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v) ? v : undefined;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** JSON safe to inline in a <script> element (no "</script>", "<!--" or line separators). */
export function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function cssFamily(name: string): string {
  // Font families are data; strip anything that could escape the CSS string.
  // Single quotes: the value is embedded in double-quoted style attributes.
  return `'${cleanFamily(name)}'`;
}

function cleanFamily(name: string): string {
  return name.replace(/[^\p{L}\p{N} ._-]/gu, "").trim() || "sans-serif";
}

const f3 = (n: number) => Number(n.toFixed(3));

export function compileComposition(doc: ProjectDocument, ctx: CompileContext): CompiledBundle {
  const { width, height } = dimensionsFor(doc.format.aspect, ctx.scale);
  const fps = doc.format.fps;
  const timeline = computeTimeline(doc);
  // Absolute seconds of music accents (markers of the chosen kind), when enabled.
  const accentTimes = doc.musicAccents.enabled ? doc.markers.filter((mk) => mk.kind === doc.musicAccents.on || (doc.musicAccents.on === "downbeat" && mk.kind === "section")).map((mk) => mk.frame / doc.format.fps).sort((a, b) => a - b) : [];
  const durationSec = timeline.totalFrames / fps;
  const unit = Math.min(width, height) / 1080;
  const brand = doc.brand;
  const profile = doc.profile;
  const safe = SAFE_AREA_PRESETS[doc.format.safeArea];
  const warnings: string[] = [];
  const extraFiles: { path: string; source: string }[] = [];
  const scripts: string[] = [];
  const scriptSrcs = new Set<string>();
  const tweens: string[] = [];
  const sec = (frames: number) => f3(frames / fps);

  const boxFor = (slot: SlotBox | undefined, override?: { x: number; y: number; w: number; h: number }): Box => {
    const s = override ? { ...override, bleed: true } : slot ?? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    if (s.bleed) return { left: s.x * width, top: s.y * height, width: s.w * width, height: s.h * height };
    const sx = safe.left * width;
    const sy = safe.top * height;
    const sw = (1 - safe.left - safe.right) * width;
    const sh = (1 - safe.top - safe.bottom) * height;
    return { left: sx + s.x * sw, top: sy + s.y * sh, width: s.w * sw, height: s.h * sh };
  };
  const boxCss = (b: Box) => `left:${f3(b.left)}px;top:${f3(b.top)}px;width:${f3(b.width)}px;height:${f3(b.height)}px;`;

  const heading = brand.fonts.heading;
  const body = brand.fonts.body;
  const fontFaces = ctx.fonts
    .map((f) => `@font-face{font-family:${cssFamily(f.family)};src:url("${f.file}");font-weight:${f.weight};font-style:${f.style ?? "normal"};font-display:block;}`)
    .join("\n");
  const knownFamilies = new Set(ctx.fonts.map((f) => f.family));
  for (const fr of [heading, body]) {
    if (!knownFamilies.has(fr.family)) warnings.push(`Font "${fr.family}" is not available; the fallback sans-serif will be used.`);
  }

  const motion = (scene: Scene) => {
    const k = Math.max(0, Math.min(1, scene.motionIntensity * (0.5 + profile.motionIntensity)));
    const pace = profile.pacing === "fast" ? 0.7 : profile.pacing === "calm" ? 1.35 : 1;
    return { dist: (30 + 110 * k) * unit, dur: f3(Math.max(0.25, (0.95 - 0.45 * k) * pace)), k };
  };

  const sceneHtml: string[] = [];
  doc.scenes.forEach((scene, index) => {
    const t = timeline.scenes[index]!;
    const start = sec(t.start);
    const dur = sec(t.duration);
    const m = motion(scene);
    const sid = `s-${scene.id}`;
    const parts: string[] = [];
    const exits: string[] = [];
    parts.push(backgroundHtml(scene.background, brand, ctx, sid, start, dur, warnings));
    if (scene.background.type !== "asset") {
      // A soft light in the brand colour drifting across flat backgrounds: depth without clutter.
      parts.push(`<div class="bglight" id="${sid}-light" style="background:radial-gradient(closest-side, ${hexWithAlpha(resolveColor(brand, "brand.primary", "#4455ff"), 0.28)}, transparent);"></div>`);
      const dx = index % 2 === 0 ? 1 : -1;
      tweens.push(`tl.fromTo("#${sid}-light",{xPercent:${-8 * dx},yPercent:-6,scale:1},{xPercent:${8 * dx},yPercent:6,scale:1.08,duration:${dur},ease:"sine.inOut"},${start});`);
    }

    // Talking-head program: kept source segments inside this scene, in the presenter slot.
    if (doc.program) {
      const src = ctx.assets.get(doc.program.sourceAssetId);
      const pslot = resolveSlot(scene.layout, doc.format.aspect, "presenter");
      if (!src) warnings.push("The source recording is missing; the presenter is omitted.");
      else if (pslot && doc.program.presenterFraming !== "hidden") {
        const pbox = boxFor(pslot);
        const rounded = scene.layout === "presenter-inset" || scene.layout === "lesson-takeaway" || doc.program.presenterFraming === "rounded-inset" || doc.profile.framing === "rounded-inset";
        const radius = rounded ? `border-radius:${f3(Math.min(pbox.width, pbox.height) * 0.08)}px;` : "";
        const shadow = rounded ? "box-shadow:0 12px 40px rgba(0,0,0,.45);" : "";
        let segIndex = 0;
        for (const seg of programSegments(doc)) {
          const a = Math.max(seg.outStart, t.start);
          const b = Math.min(seg.outStart + seg.frames, t.end);
          if (b <= a) continue;
          const srcIn = seg.entry.sourceInSec + (a - seg.outStart) / fps;
          const vid = `pg-${scene.id}-${segIndex++}`;
          // Jump-cut punch-in on alternate segments for fast (social) pacing.
          const punch = profile.pacing === "fast" && segIndex % 2 === 0 ? 1.12 : 1;
          parts.push(
            `<div class="layer media presenter" style="left:${f3(pbox.left)}px;top:${f3(pbox.top)}px;width:${f3(pbox.width)}px;height:${f3(pbox.height)}px;z-index:${(pslot.z ?? 1) * 10};${radius}${shadow}"><video id="${vid}" src="${src.file}" muted playsinline data-start="${sec(a)}" data-duration="${sec(b - a)}" data-media-start="${f3(srcIn)}" style="width:100%;height:100%;object-fit:cover;object-position:50% 35%;transform:scale(${punch});transform-origin:50% 40%;"></video></div>`,
          );
        }
      }
    }

    // Animatic: a video shot with a keyframe but no footage yet plays its keyframe as a slow
    // still, visibly tagged, so timing can be judged before paying for video.
    const keyframe = scene.shot && !scene.shot.acceptedAssetId && scene.shot.keyframeAssetId ? ctx.assets.get(scene.shot.keyframeAssetId) : undefined;
    if (keyframe) {
      const shotNo = doc.scenes.filter((x) => x.shot).findIndex((x) => x.id === scene.id) + 1;
      warnings.push(`Shot ${shotNo} (“${scene.purpose}”) shows its keyframe (animatic), not generated video.`);
      parts.push(
        `<div class="layer" style="left:0;top:0;width:100%;height:100%;z-index:5;overflow:hidden;background:#000"><img id="${sid}-kf" src="${keyframe.file}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform-origin:50% 50%"></div>` +
          `<div class="layer" style="left:${f3(24 * unit)}px;bottom:${f3(22 * unit)}px;z-index:900;padding:${f3(4 * unit)}px ${f3(10 * unit)}px;border-radius:${f3(6 * unit)}px;background:rgba(0,0,0,.6);color:#fbbf24;font:700 ${f3(18 * unit)}px ${cssFamily(brand.fonts.body.family)},sans-serif;letter-spacing:.12em">KEYFRAME · SHOT ${shotNo}</div>`,
      );
      tweens.push(`tl.fromTo("#${sid}-kf",{scale:1.0},{scale:1.08,duration:${dur},ease:"none"},${start});`);
    }
    // Footage shot without accepted media or keyframe: an explicit slate, never a fake frame.
    if (scene.shot && !scene.shot.acceptedAssetId && !keyframe) {
      const shotNo = doc.scenes.filter((x) => x.shot).findIndex((x) => x.id === scene.id) + 1;
      const label = scene.shot.status === "failed" ? "generation failed" : scene.shot.status === "generating" ? "generating…" : "awaiting footage";
      warnings.push(`Shot ${shotNo} (“${scene.purpose}”) has no footage yet (${label}).`);
      parts.push(
        `<div class="layer" style="left:0;top:0;width:100%;height:100%;z-index:5;background:repeating-linear-gradient(135deg,#0b0d14 0 ${f3(28 * unit)}px,#11141d ${f3(28 * unit)}px ${f3(56 * unit)}px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${f3(14 * unit)}px;font-family:${cssFamily(brand.fonts.body.family)},sans-serif;color:#cbd5e1;text-align:center;padding:0 10%;box-sizing:border-box"><div style="font-size:${f3(64 * unit)}px;font-weight:800;letter-spacing:.08em;color:#f8fafc">SHOT ${shotNo}</div><div style="font-size:${f3(26 * unit)}px;text-transform:uppercase;letter-spacing:.2em;color:#f59e0b">${escapeHtml(label)}</div><div style="font-size:${f3(22 * unit)}px;max-width:80%;opacity:.8">${escapeHtml(scene.shot.prompt.slice(0, 160))}</div></div>`,
      );
    }

    // Background "ken burns" drift on asset backgrounds.
    if (scene.background.type === "asset" && m.k > 0.2) {
      tweens.push(`tl.fromTo("#${sid}-bgimg",{scale:1},{scale:${f3(1 + 0.06 * m.k)},duration:${dur},ease:"none"},${start});`);
    }

    scene.layers.forEach((layer, li) => {
      if (layer.hidden) return;
      const lid = `l-${scene.id}-${layer.id}`;
      const slot = resolveSlot(scene.layout, doc.format.aspect, layer.slot);
      if (!slot && !layer.box) warnings.push(`Layout "${scene.layout}" has no slot "${layer.slot}" for ${doc.format.aspect}; using a default box.`);
      // A half-filled media grid centres its single row instead of leaving the lower half empty.
      const gridFilled = scene.layout === "media-grid" ? scene.layers.filter((x) => (x.kind === "image" || x.kind === "video") && x.assetId && !x.hidden).length : 6;
      const centred = scene.layout === "media-grid" && gridFilled <= 3 && slot && !layer.box && /^media\d?$/.test(layer.slot) ? { ...slot, y: 0.3 } : slot;
      const box = boxFor(centred, layer.box);
      const z = (slot?.z ?? 2) * 10 + li;
      const delay = f3(start + ("animation" in layer ? layer.animation.delayFrames / fps : 0));
      switch (layer.kind) {
        case "text": {
          // Display text rises word by word from behind a mask (the "kinetic" reveal); other
          // roles keep their block entrance. Words stay in place for fitting and captions.
          const masked = layer.animation.in === "rise" && !layer.animation.stagger && MASKED_ROLES.has(layer.role) && layer.text.split(/\s+/).length <= 18;
          parts.push(textHtml(layer, lid, box, z, slot, brand, profile.typeScale * unit, masked));
          if (masked) {
            const n = Math.max(1, layer.text.split(/\s+/).filter(Boolean).length);
            tweens.push(`tl.fromTo("#${lid} .wm > .w",{yPercent:115},{yPercent:0,duration:${f3(Math.max(0.35, Number(m.dur) * 0.9))},stagger:${f3(Math.min(0.09, (dur * 0.3) / n))},ease:"power4.out"},${delay});`);
          } else {
            tweens.push(...entrance(`#${lid}`, layer.animation.in, delay, m, layer.animation.stagger));
          }
          if (layer.animation.in === "type" || layer.animation.stagger) {
            tweens.push(`tl.fromTo("#${lid} .w",{opacity:0,y:${f3(m.dist * 0.4)}},{opacity:1,y:0,duration:${f3(m.dur * 0.6)},stagger:${f3(Math.min(0.12, (dur * 0.35) / Math.max(1, layer.text.split(/\s+/).length)))},ease:"power2.out"},${delay});`);
          }
          // Gentle drift while on screen, so held frames are never frozen.
          tweens.push(`tl.fromTo("#${lid} .fit",{y:0},{y:${f3(-(6 + 10 * m.k) * unit)},duration:${dur},ease:"none"},${start});`);
          exits.push(`#${lid}`);
          break;
        }
        case "image":
          parts.push(imageHtml(layer, lid, box, z, ctx, brand, unit, warnings, scene, start, dur));
          tweens.push(...entrance(`#${lid}`, layer.animation.in, delay, m));
          exits.push(`#${lid}`);
          if (layer.animation.kenBurns) {
            tweens.push(`tl.fromTo("#${lid} .media-inner",{scale:1},{scale:${f3(1 + 0.08 * Math.max(0.3, m.k))},duration:${dur},ease:"none"},${start});`);
          }
          break;
        case "video": {
          parts.push(videoHtml(layer, lid, box, z, ctx, start, dur, unit, warnings, scene, brand));
          tweens.push(...entrance(`#${lid}`, layer.animation.in, delay, m));
          if (layer.animation.punchIn > 1) {
            tweens.push(`tl.fromTo("#${lid} .media-inner",{scale:1},{scale:${f3(layer.animation.punchIn)},duration:${f3(Math.min(dur, 0.6))},ease:"power2.inOut"},${f3(start + dur * 0.45)});`);
          }
          break;
        }
        case "shape":
          parts.push(shapeHtml(layer, lid, box, z, brand, unit));
          tweens.push(...entrance(`#${lid}`, layer.animation.in, delay, m));
          tweens.push(...shapeLoop(layer, lid, start, dur, m.k, accentTimes.filter((a) => a >= start - 1e-6 && a < start + dur), doc.musicAccents.strength));
          break;
        case "character": {
          const ch = doc.characters.find((c) => c.id === layer.characterId);
          if (!ch) {
            warnings.push(`Scene "${scene.purpose}" references a character that no longer exists.`);
            break;
          }
          const cutout = ch.mode === "image" ? ctx.assets.get(ch.poseAssets[layer.pose] ?? ch.referenceAssetIds[0] ?? "") : undefined;
          const vector = !cutout;
          if (ch.mode === "image" && !cutout) warnings.push(`${ch.name}: no reference image is available; the vector version is shown.`);
          // Scale around the feet so the character stays grounded in its slot.
          const flip = layer.facing === "left" ? "scaleX(-1)" : "";
          const inner = vector ? characterSvg(ch, lid, layer.accessory) : `<img id="${lid}-img" src="${cutout!.file}" alt="${escapeHtml(ch.name)}" style="width:100%;height:100%;object-fit:contain;object-position:50% 100%">`;
          parts.push(`<div class="layer character" id="${lid}" style="${boxCss(box)}z-index:${z};"><div style="position:absolute;inset:0;transform:${flip} scale(${f3(layer.scale)});transform-origin:50% 100%">${inner}</div></div>`);
          tweens.push(...entrance(`#${lid}`, layer.animation.in, delay, m));
          tweens.push(...characterTweens(layer, ch, lid, start, dur, m.k, vector));
          break;
        }
        case "graphics": {
          if (!ctx.graphics) throw new GraphicsUnavailableError(`No ${layer.backend} graphics backend is configured for this render.`);
          const frag = ctx.graphics(layer, { sceneStartSec: start, sceneDurationSec: dur, width, height, box, brand, fonts: ctx.fonts, assetFile: (id) => ctx.assets.get(id)?.file });
          parts.push(`<div class="layer gfx" id="${lid}" style="${boxCss(box)}z-index:${z};">${frag.html}</div>`);
          if (frag.script) scripts.push(frag.script);
          for (const src of frag.scriptSrcs ?? []) scriptSrcs.add(src);
          for (const f of frag.files ?? []) if (!extraFiles.some((e) => e.path === f.path)) extraFiles.push(f);
          break;
        }
      }
    });

    // Brand logo bug on non end-card scenes.
    if (brand.logoAssetId && brand.logoPlacement !== "end-card-only" && scene.layout !== "end-card") {
      const logo = ctx.assets.get(brand.logoAssetId);
      if (logo) {
        const s = 0.07;
        const [px, py] = brand.logoPlacement.split("-") as ["top" | "bottom", "left" | "right"];
        const lb = boxFor({ x: py === "left" ? 0 : 1 - s * 1.6, y: px === "top" ? 0 : 1 - s, w: s * 1.6, h: s });
        parts.push(`<div class="layer" style="${boxCss(lb)}z-index:95;"><img src="${logo.file}" style="width:100%;height:100%;object-fit:contain;object-position:${py} ${px};opacity:.92" alt=""></div>`);
      }
    }

    sceneHtml.push(
      `<div id="${sid}" class="clip scene" data-start="${start}" data-duration="${dur}" style="z-index:${index + 1};">${parts.join("")}</div>`,
    );

    // Content eases out just before a hard cut (not before overlapping transitions, which cover
    // it, not on the final scene, which holds, and not when cuts are timed to music markers).
    const next = doc.scenes[index + 1];
    const cutAfter = !!next && (next.transitionIn.type === "cut" || (timeline.scenes[index + 1]?.overlapIn ?? 0) === 0);
    if (cutAfter && exits.length && !doc.markers.length && t.duration / fps >= 1.5) {
      const d = Math.min(0.3, (t.duration / fps) * 0.08);
      const at = f3((t.start + t.duration) / fps - d - 1 / fps);
      tweens.push(`tl.fromTo(${scriptJson(exits.join(","))},{opacity:1},{opacity:0,duration:${f3(d)},ease:"power2.in",immediateRender:false},${at});`);
    }

    if (index > 0 && t.overlapIn > 0) {
      const o = sec(t.overlapIn);
      switch (scene.transitionIn.type) {
        case "fade":
          tweens.push(`tl.fromTo("#${sid}",{opacity:0},{opacity:1,duration:${o},ease:"none"},${start});`);
          break;
        case "slide": {
          tweens.push(`tl.fromTo("#${sid}",{xPercent:100},{xPercent:0,duration:${o},ease:"power3.inOut"},${start});`);
          // The outgoing scene is pushed along, not just covered.
          const prev = `s-${doc.scenes[index - 1]!.id}`;
          tweens.push(`tl.fromTo("#${prev}",{xPercent:0},{xPercent:-35,duration:${o},ease:"power3.inOut",immediateRender:false},${start});`);
          break;
        }
        case "wipe":
          tweens.push(`tl.fromTo("#${sid}",{clipPath:"inset(0% 100% 0% 0%)"},{clipPath:"inset(0% 0% 0% 0%)",duration:${o},ease:"power2.inOut"},${start});`);
          break;
        case "zoom": {
          tweens.push(`tl.fromTo("#${sid}",{opacity:0,scale:1.12},{opacity:1,scale:1,duration:${o},ease:"power2.out"},${start});`);
          const prev = `s-${doc.scenes[index - 1]!.id}`;
          tweens.push(`tl.fromTo("#${prev}",{scale:1},{scale:0.94,duration:${o},ease:"power2.in",immediateRender:false},${start});`);
          break;
        }
      }
    }
  });

  // Editorial beats (FR-14): overlays placed at their mapped output time.
  const beatHtml: string[] = [];
  if (doc.program) {
    doc.beats.forEach((beat, i) => {
      if (beat.cue.sourceStartSec === undefined) return;
      const at = sourceToOutput(doc, beat.cue.sourceStartSec, { snap: "next" });
      if (at === null || at >= timeline.totalFrames) return;
      const len = Math.min(beat.durationFrames, timeline.totalFrames - at);
      const portrait = doc.format.aspect === "9:16";
      const media = beat.visualAction === "logo" || beat.visualAction === "image" || beat.visualAction === "b-roll";
      // Portrait: media cards are wide and short so they sit below the face, above captions.
      const w = beat.visualAction === "emphasis" ? 0.8 : portrait ? (media ? 0.9 : 0.8) : 0.34;
      const h = beat.visualAction === "emphasis" ? 0.14 : beat.visualAction === "label" ? (portrait ? 0.07 : 0.12) : portrait ? 0.24 : 0.28;
      const ax = beat.anchor?.x ?? (i % 2 === 0 ? 0.22 : 0.78);
      const ay = beat.anchor?.y ?? (beat.visualAction === "emphasis" ? 0.7 : 0.3);
      const bx = Math.max(0, Math.min(1 - w, ax - w / 2));
      const by = Math.max(0, Math.min(1 - h, ay - h / 2));
      const box = boxFor({ x: bx, y: by, w, h });
      const bid = `beat-${i}`;
      const size = (beat.visualAction === "emphasis" ? 64 : 40) * unit * profile.typeScale;
      const back = beat.backing === "solid" ? resolveColor(brand, "brand.surface", "#111111") : hexWithAlpha(resolveColor(brand, "brand.surface", "#111111"), 0.86);
      let inner = "";
      if ((beat.visualAction === "logo" || beat.visualAction === "image" || beat.visualAction === "b-roll") && beat.assetId && ctx.assets.get(beat.assetId)) {
        const a = ctx.assets.get(beat.assetId)!;
        // Contrast fallback (FR-14): a dark logo gets a light card, a light logo a dark card.
        const darkLogo = a.opaqueLuma !== undefined && a.opaqueLuma !== null && a.opaqueLuma < 0.45;
        const cardBg = darkLogo ? hexWithAlpha("#f8fafc", beat.backing === "solid" ? 1 : 0.94) : back;
        const cardInk = darkLogo ? "#0f172a" : resolveColor(brand, "brand.text", "#fff");
        if (a.kind === "video") {
          // Moving B-roll: muted (speech is never replaced), cropped into a rounded card.
          inner = `<div style="width:100%;height:100%;border-radius:${f3(18 * unit)}px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.4)"><video id="${`beat-${i}-v`}" src="${a.file}" muted playsinline data-start="${sec(at)}" data-duration="${sec(len)}" data-media-start="0" style="width:100%;height:100%;object-fit:cover"></video></div>`;
        } else
        inner = `<div style="width:100%;height:100%;background:${cardBg};border-radius:${f3(18 * unit)}px;padding:${f3(12 * unit)}px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:${f3(12 * unit)}px"><img src="${a.file}" alt="" style="max-height:100%;max-width:${beat.text ? "40%" : "100%"};object-fit:contain">${beat.text ? `<span style="font-size:${f3(size)}px;font-weight:700;color:${cardInk}">${escapeHtml(beat.text)}</span>` : ""}</div>`;
      } else {
        inner = `<div class="fit" data-size="${f3(size)}" style="font-size:${f3(size)}px;font-family:${cssFamily(brand.fonts.heading.family)},sans-serif;font-weight:${brand.fonts.heading.weight};color:${resolveColor(brand, "brand.text", "#ffffff")};justify-content:center;text-align:center;"><div><span style="background:${back};padding:.12em .45em;border-radius:.25em;-webkit-box-decoration-break:clone;box-decoration-break:clone;">${escapeHtml(beat.text || beat.cue.phrase)}</span></div></div>`;
      }
      beatHtml.push(`<div id="${bid}" class="clip beat" data-start="${sec(at)}" data-duration="${sec(len)}" style="z-index:800;pointer-events:none;"><div class="layer" id="${bid}-in" style="${boxCss(box)}">${inner}</div></div>`);
      tweens.push(`tl.fromTo("#${bid}-in",{opacity:0,y:${f3(20 * unit)}},{opacity:1,y:0,duration:0.35,ease:"power2.out"},${sec(at)});`);
    });
  }

  // Section flashes: a brief full-frame lift on each section marker (music accents).
  if (doc.musicAccents.enabled && doc.musicAccents.sectionFlash) {
    doc.markers
      .filter((mk) => mk.kind === "section" && mk.frame > 0 && mk.frame < timeline.totalFrames)
      .forEach((mk, i) => {
        const at = mk.frame / fps;
        beatHtml.push(`<div id="flash-${i}" class="clip" data-start="${f3(at)}" data-duration="${f3(Math.min(0.5, timeline.totalFrames / fps - at))}" style="z-index:700;pointer-events:none;"><div id="flash-${i}-in" class="layer" style="left:0;top:0;width:100%;height:100%;background:#ffffff;opacity:0"></div></div>`);
        tweens.push(`tl.fromTo("#flash-${i}-in",{opacity:${f3(0.45 * doc.musicAccents.strength)}},{opacity:0,duration:0.45,ease:"power2.out"},${f3(at)});`);
      });
  }

  // Captions (burned in) — absolute clips above all scenes.
  const captionHtml: string[] = [];
  if (doc.captions.enabled && doc.captions.burnIn) {
    const cues = resolveCaptions(doc, timeline);
    const capBox = boxFor(
      doc.captions.position === "top" ? { x: 0.06, y: 0.02, w: 0.88, h: 0.16 } : doc.captions.position === "middle" ? { x: 0.06, y: 0.42, w: 0.88, h: 0.16 } : { x: 0.06, y: 0.82, w: 0.88, h: 0.16 },
    );
    const size = 46 * unit * (doc.format.aspect === "9:16" ? 1.15 : 1);
    cues.forEach((c, i) => {
      captionHtml.push(
        `<div id="cap-${i}" class="clip cap cap-${doc.captions.style}" data-start="${sec(c.start)}" data-duration="${sec(c.end - c.start)}" style="${boxCss(capBox)}z-index:900;font-size:${f3(size)}px;"><span>${escapeHtml(c.cue.text)}</span></div>`,
      );
    });
  }

  const audioHtml = ctx.audioMix
    ? `<audio id="mix" src="${ctx.audioMix.file}" data-start="0" data-duration="${f3(durationSec)}" data-volume="1"></audio>`
    : "";

  const textColor = resolveColor(brand, "brand.text", "#ffffff");
  const css = `
${fontFaces}
html,body{margin:0;padding:0;background:#000;}
#root{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:${resolveColor(brand, "brand.background", "#000000")};font-family:${cssFamily(body.family)},sans-serif;color:${textColor};}
.clip{position:absolute;inset:0;}
.scene{overflow:hidden;}
.layer{position:absolute;box-sizing:border-box;}
.bg{position:absolute;inset:0;overflow:hidden;}
.bg img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}
.fit{width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;line-height:1.08;word-break:normal;overflow-wrap:break-word;hyphens:none;}
.fit>span{display:inline;}
.role-cta .fit{justify-content:center;}
.cta-pill{display:inline-block;padding:.35em .9em;border-radius:999px;}
.backing-solid>span,.backing-translucent>span{padding:.08em .32em;border-radius:.18em;-webkit-box-decoration-break:clone;box-decoration-break:clone;}
.backing-solid>div,.backing-translucent>div{padding:.1em .34em;}
.media{overflow:hidden;display:flex;align-items:center;justify-content:center;}
.media-inner{width:100%;height:100%;display:flex;align-items:center;justify-content:center;}
.media img,.media video{max-width:100%;max-height:100%;display:block;}
.cap{display:flex;align-items:center;justify-content:center;text-align:center;line-height:1.2;}
.cap span{padding:.18em .5em;border-radius:.3em;-webkit-box-decoration-break:clone;box-decoration-break:clone;}
.cap-boxed span{background:rgba(0,0,0,.72);color:#fff;}
.cap-bold span{color:#fff;font-weight:800;text-shadow:0 .06em 0 #000,0 0 .3em rgba(0,0,0,.9);-webkit-text-stroke:.03em #000;}
.cap-clean span{color:#fff;text-shadow:0 .05em .25em rgba(0,0,0,.95);}
.cap-minimal span{color:#fff;background:rgba(0,0,0,.45);}
.w{display:inline-block;white-space:pre;}
.wm{display:inline-block;overflow:hidden;vertical-align:top;padding:0 .04em .16em;margin:0 -.04em -.16em;}
.bglight{position:absolute;left:-15%;top:-15%;width:130%;height:130%;pointer-events:none;}
#finish{position:absolute;inset:0;pointer-events:none;z-index:850;}
#finish .vig{position:absolute;inset:0;background:radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,.38) 100%);}
#finish .grain{position:absolute;inset:-50%;opacity:.07;mix-blend-mode:overlay;background-size:256px 256px;}
`;

  const fitScript = `
(function(){
  window.__hf = window.__hf || {}; window.__hf.buildReady = window.__hf.buildReady || {};
  window.__vsReport = { overflow: [], missingFonts: [], shrunk: [] };
  function fitAll(){
    var els = document.querySelectorAll('.fit');
    for (var i=0;i<els.length;i++){
      var el = els[i]; var base = parseFloat(el.getAttribute('data-size')); var s = base; el.style.fontSize = s+'px';
      var guard = 0;
      // Measure the content block itself: bottom-aligned content overflows upward, which the
      // container's scrollHeight never reports.
      var over = function(){ var c = el.firstElementChild || el; return c.offsetHeight > el.clientHeight + 1 || c.scrollWidth > el.clientWidth + 1 || el.scrollWidth > el.clientWidth + 1; };
      while (over() && s > base*0.4 && guard < 60){ s = s*0.95; el.style.fontSize = s+'px'; guard++; }
      if (over()){ el.setAttribute('data-overflow','true'); window.__vsReport.overflow.push(el.parentElement.id); }
      el.setAttribute('data-fitted', (s/base).toFixed(3));
      if (s/base < 0.75) window.__vsReport.shrunk.push({ id: el.parentElement.id, ratio: Math.round(s/base*1000)/1000, px: Math.round(s*10)/10 });
    }
  }
  var fams = ${scriptJson([...new Set([cleanFamily(heading.family), cleanFamily(body.family)])])};
  window.__hf.buildReady["vs-fit"] = (document.fonts ? document.fonts.ready : Promise.resolve()).then(function(){
    return Promise.all(fams.map(function(f){ return document.fonts.load('700 32px "'+f+'"').then(function(r){ if(!r.length) window.__vsReport.missingFonts.push(f); }).catch(function(){ window.__vsReport.missingFonts.push(f); }); }));
  }).then(fitAll);
})();`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="generator" content="video-studio-compositor/5">
<style>${css}</style>
<script src="${ctx.gsapFile}"></script>
</head><body>
<div id="root" data-composition-id="main" data-start="0" data-width="${width}" data-height="${height}" data-duration="${f3(durationSec)}">
${sceneHtml.join("\n")}
<div id="finish"><div class="vig"></div><div class="grain" id="grain" style="background-image:url(&quot;${GRAIN_SVG}&quot;);"></div></div>
${beatHtml.join("\n")}
${captionHtml.join("\n")}
${audioHtml}
</div>
<script>${fitScript}</script>
<script>
window.__timelines = window.__timelines || {};
var tl = gsap.timeline({ paused: true });
${tweens.join("\n")}
tl.fromTo("#grain",{x:0,y:0},{x:${f3(-200 * unit)},y:${f3(-140 * unit)},duration:${f3(durationSec)},ease:"steps(${Math.max(1, Math.round(durationSec * 12))})"},0);
tl.set({}, {}, ${f3(durationSec)});
window.__timelines["main"] = tl;
</script>
${scripts.map((s) => `<script>${s}</script>`).join("\n")}
${[...scriptSrcs].map((src) => `<script src="${escapeHtml(src)}"></script>`).join("\n")}
</body></html>`;

  const manifest = {
    compiler: "video-studio-compositor/5",
    width,
    height,
    fps,
    totalFrames: timeline.totalFrames,
    seed: doc.seed,
    assets: [...ctx.assets.entries()].map(([id, a]) => ({ id, file: a.file })).sort((a, b) => a.id.localeCompare(b.id)),
    fonts: ctx.fonts.map((f) => f.file).sort(),
  };

  return { html, width, height, fps, totalFrames: timeline.totalFrames, durationSec, timeline, extraFiles, manifest, warnings };
}

function entrance(sel: string, kind: string, at: number, m: { dist: number; dur: number }, staggerOnly = false): string[] {
  if (staggerOnly && kind !== "type") return [];
  switch (kind) {
    case "none":
    case "type":
      return [];
    case "fade":
      return [`tl.fromTo("${sel}",{opacity:0},{opacity:1,duration:${m.dur},ease:"power1.out"},${at});`];
    case "rise":
      return [`tl.fromTo("${sel}",{opacity:0,y:${f3(m.dist)}},{opacity:1,y:0,duration:${m.dur},ease:"power3.out"},${at});`];
    case "pop":
      return [`tl.fromTo("${sel}",{opacity:0,scale:0.6},{opacity:1,scale:1,duration:${m.dur},ease:"back.out(1.7)"},${at});`];
    case "slide":
      return [`tl.fromTo("${sel}",{opacity:0,x:${f3(-m.dist * 1.5)}},{opacity:1,x:0,duration:${m.dur},ease:"power3.out"},${at});`];
    case "wipe":
      return [`tl.fromTo("${sel}",{clipPath:"inset(0% 100% 0% 0%)"},{clipPath:"inset(0% 0% 0% 0%)",duration:${m.dur},ease:"power2.inOut"},${at});`];
    case "draw":
      return [`tl.fromTo("${sel}",{clipPath:"inset(0% 0% 100% 0%)"},{clipPath:"inset(0% 0% 0% 0%)",duration:${f3(m.dur * 1.4)},ease:"power1.inOut"},${at});`];
    default:
      return [];
  }
}

/** Roles whose words rise from behind a mask when entering with "rise". */
const MASKED_ROLES = new Set<TextLayer["role"]>(["headline", "stat", "quote"]);

function textHtml(layer: TextLayer, lid: string, box: Box, z: number, slot: SlotBox | undefined, brand: BrandSnapshot, sizeUnit: number, masked = false): string {
  const role = layer.role;
  const size = ROLE_SIZE[role] * layer.style.scale * sizeUnit;
  const fontRef = ROLE_FONT[role] === "heading" ? brand.fonts.heading : brand.fonts.body;
  const weight = role === "headline" || role === "stat" || role === "cta" || role === "quote" ? fontRef.weight : role === "kicker" ? 600 : Math.min(fontRef.weight, 500);
  const align = layer.style.align ?? slot?.align ?? "start";
  const valign = slot?.valign ?? "center";
  const jc = { start: "flex-start", center: "center", end: "flex-end" }[valign];
  const ta = { start: "left", center: "center", end: "right" }[align];
  const color =
    role === "cta"
      ? resolveColor(brand, layer.style.color ?? "brand.text", "#ffffff")
      : role === "kicker" || role === "stat"
        ? resolveColor(brand, layer.style.color ?? "brand.accent", "#ffffff")
        : resolveColor(brand, layer.style.color ?? "brand.text", "#ffffff");
  const upper = layer.style.uppercase ?? role === "kicker";
  const letter = role === "kicker" ? "letter-spacing:.14em;" : role === "headline" || role === "stat" ? "letter-spacing:-.02em;" : "";
  const backing = layer.style.backing;
  const backCss =
    backing === "solid"
      ? `background:${resolveColor(brand, "brand.surface", "#111111")};`
      : backing === "translucent"
        ? `background:${hexWithAlpha(resolveColor(brand, "brand.surface", "#111111"), 0.82)};`
        : "";
  const words = escapeHtml(layer.text)
    .split(/(\s+)/)
    .map((w) => (w.trim() ? (masked ? `<span class="wm"><span class="w">${w}</span></span>` : `<span class="w">${w}</span>`) : w))
    .join("");
  const inner =
    role === "cta"
      ? `<span class="cta-pill" style="background:${resolveColor(brand, "brand.primary", "#3355ff")};">${words}</span>`
      : `<span style="${backCss}">${words}</span>`;
  return `<div class="layer text role-${role}" id="${lid}" style="left:${f3(box.left)}px;top:${f3(box.top)}px;width:${f3(box.width)}px;height:${f3(box.height)}px;z-index:${z};"><div class="fit backing-${backing}" data-size="${f3(size)}" style="font-size:${f3(size)}px;font-family:${cssFamily(fontRef.family)},sans-serif;font-weight:${weight};color:${color};text-align:${ta};justify-content:${jc};${upper ? "text-transform:uppercase;" : ""}${letter}">${`<div>${inner}</div>`}</div></div>`;
}

function hexWithAlpha(hex: string, a: number): string {
  const h = hex.slice(1, 7);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function frameWrap(frame: string, inner: string, brand: BrandSnapshot, unit: number): { outerCss: string; html: string } {
  const surface = resolveColor(brand, "brand.surface", "#1b1b1b");
  switch (frame) {
    case "card":
      return { outerCss: `border-radius:${f3(22 * unit)}px;box-shadow:0 ${f3(24 * unit)}px ${f3(60 * unit)}px rgba(0,0,0,.45);background:${surface};`, html: inner };
    case "rounded":
      return { outerCss: `border-radius:${f3(28 * unit)}px;`, html: inner };
    case "circle":
      return { outerCss: `border-radius:50%;`, html: inner };
    case "laptop":
      return {
        outerCss: "overflow:visible;flex-direction:column;",
        html: `<div style="width:100%;height:90%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;"><div style="box-sizing:border-box;height:100%;aspect-ratio:16/10.4;max-width:100%;background:#0d0d0f;border:${f3(10 * unit)}px solid #2a2a2e;border-radius:${f3(18 * unit)}px ${f3(18 * unit)}px ${f3(4 * unit)}px ${f3(4 * unit)}px;overflow:hidden;display:flex;align-items:center;justify-content:center;">${inner}</div></div><div style="width:100%;height:4%;background:linear-gradient(#cfd2d8,#8d9097);border-radius:0 0 ${f3(20 * unit)}px ${f3(20 * unit)}px;"></div>`,
      };
    case "phone":
      return {
        outerCss: "overflow:visible;",
        html: `<div style="box-sizing:border-box;height:100%;aspect-ratio:9/19.5;max-width:100%;background:#0d0d0f;border:${f3(12 * unit)}px solid #232327;border-radius:${f3(56 * unit)}px;overflow:hidden;display:flex;align-items:center;justify-content:center;box-shadow:0 ${f3(30 * unit)}px ${f3(70 * unit)}px rgba(0,0,0,.5);">${inner}</div>`,
      };
    default:
      return { outerCss: "", html: inner };
  }
}

function mediaStyle(fit: string, focal: { x: number; y: number }, frame: string): string {
  const device = frame === "laptop" || frame === "phone" || frame === "circle";
  return `width:100%;height:100%;${device || fit === "cover" ? "object-fit:cover;" : "object-fit:contain;"}object-position:${f3(focal.x * 100)}% ${f3(focal.y * 100)}%;`;
}

function imageHtml(layer: ImageLayer, lid: string, box: Box, z: number, ctx: CompileContext, brand: BrandSnapshot, unit: number, warnings: string[], scene: Scene, start: number, dur: number): string {
  const asset = layer.assetId ? ctx.assets.get(layer.assetId) : undefined;
  if (!asset) {
    warnings.push(`Scene "${scene.purpose}": image slot "${layer.slot}" is empty and is omitted from the render.`);
    return "";
  }
  // A clip placed in an image slot (e.g. supplied footage) plays as video from its start.
  if (asset.kind === "video") return videoHtml({ ...layer, kind: "video", sourceInSec: 0, sourceOutSec: null, muted: true, animation: { in: layer.animation.in, delayFrames: layer.animation.delayFrames, punchIn: 1 } }, lid, box, z, ctx, start, dur, unit, warnings, scene, brand);
  const img = `<div class="media-inner"><img src="${asset.file}" alt="${escapeHtml(layer.alt)}" style="${mediaStyle(layer.fit, layer.focal, layer.frame)}"></div>`;
  const w = frameWrap(layer.frame, img, brand, unit);
  return `<div class="layer media" id="${lid}" style="left:${f3(box.left)}px;top:${f3(box.top)}px;width:${f3(box.width)}px;height:${f3(box.height)}px;z-index:${z};${w.outerCss}">${w.html}</div>`;
}

function videoHtml(layer: VideoLayer, lid: string, box: Box, z: number, ctx: CompileContext, start: number, dur: number, unit: number, warnings: string[], scene: Scene, brand: BrandSnapshot): string {
  const asset = layer.assetId ? ctx.assets.get(layer.assetId) : undefined;
  if (!asset) {
    warnings.push(`Scene "${scene.purpose}": video slot "${layer.slot}" is empty and is omitted from the render.`);
    return "";
  }
  // A still placed in a video slot (an image shot, a keyframe, a supplied photo) is drawn as an image.
  if (asset.kind === "image" || asset.kind === "svg") return imageHtml({ ...layer, kind: "image", alt: "", animation: { in: layer.animation.in, delayFrames: layer.animation.delayFrames, kenBurns: false } }, lid, box, z, ctx, brand, unit, warnings, scene, start, dur);
  const available = asset.durationSec !== undefined ? Math.max(0, (layer.sourceOutSec ?? asset.durationSec) - layer.sourceInSec) : dur;
  const playDur = f3(Math.min(dur, available));
  if (playDur < dur - 0.05) warnings.push(`Scene "${scene.purpose}": video "${layer.slot}" is shorter than the scene; its last frame holds.`);
  // Audio from video layers is handled by the project mixer, so the element is always muted here.
  const v = `<div class="media-inner"><video id="v-${lid}" src="${asset.file}" muted playsinline data-start="${start}" data-duration="${playDur}" data-media-start="${f3(layer.sourceInSec)}" style="${mediaStyle(layer.fit, layer.focal, layer.frame)}"></video></div>`;
  const radius = layer.frame === "rounded" ? `border-radius:${f3(36 * unit)}px;` : layer.frame === "circle" ? "border-radius:50%;" : layer.frame === "card" ? `border-radius:${f3(22 * unit)}px;` : "";
  return `<div class="layer media" id="${lid}" style="left:${f3(box.left)}px;top:${f3(box.top)}px;width:${f3(box.width)}px;height:${f3(box.height)}px;z-index:${z};${radius}">${v}</div>`;
}

function shapeHtml(layer: ShapeLayer, lid: string, box: Box, z: number, brand: BrandSnapshot, unit: number): string {
  const c = resolveColor(brand, layer.color, "#ff6600");
  const base = `left:${f3(box.left)}px;top:${f3(box.top)}px;width:${f3(box.width)}px;height:${f3(box.height)}px;z-index:${z};`;
  switch (layer.shape) {
    case "rect":
      return `<div class="layer" id="${lid}" style="${base}background:${c};border-radius:${f3(12 * unit)}px;"></div>`;
    case "circle": {
      const d = Math.min(box.width, box.height);
      return `<div class="layer" id="${lid}" style="${base}"><div class="shape-inner" style="position:absolute;left:50%;top:50%;width:${f3(d)}px;height:${f3(d)}px;margin:${f3(-d / 2)}px 0 0 ${f3(-d / 2)}px;border-radius:50%;background:${c};"></div></div>`;
    }
    case "ring": {
      const d = Math.min(box.width, box.height);
      return `<div class="layer" id="${lid}" style="${base}"><div class="shape-inner" style="position:absolute;left:50%;top:50%;width:${f3(d)}px;height:${f3(d)}px;margin:${f3(-d / 2)}px 0 0 ${f3(-d / 2)}px;border-radius:50%;border:${f3(Math.max(4, d * 0.04))}px solid ${c};box-sizing:border-box;"></div></div>`;
    }
    case "line":
      return `<div class="layer" id="${lid}" style="${base}"><div class="shape-inner" style="position:absolute;left:0;top:50%;width:100%;height:${f3(Math.max(4, 10 * unit))}px;margin-top:${f3(-5 * unit)}px;background:${c};border-radius:99px;transform-origin:left center;"></div></div>`;
    case "blob":
      return `<div class="layer" id="${lid}" style="${base}"><div class="shape-inner" style="position:absolute;inset:0;background:radial-gradient(circle at 50% 50%, ${hexWithAlpha(c, 0.55)} 0%, ${hexWithAlpha(c, 0)} 65%);"></div></div>`;
    case "grid":
      return `<div class="layer" id="${lid}" style="${base}"><div class="shape-inner" style="position:absolute;inset:0;background-image:linear-gradient(${hexWithAlpha(c, 0.18)} 1px,transparent 1px),linear-gradient(90deg,${hexWithAlpha(c, 0.18)} 1px,transparent 1px);background-size:${f3(80 * unit)}px ${f3(80 * unit)}px;"></div></div>`;
    case "bars": {
      const n = 12;
      const bars = Array.from({ length: n }, (_, i) => `<div class="bar" style="flex:1;margin:0 ${f3(4 * unit)}px;background:${c};border-radius:${f3(6 * unit)}px ${f3(6 * unit)}px 0 0;height:${20 + ((i * 37) % 70)}%;transform-origin:bottom;"></div>`).join("");
      return `<div class="layer" id="${lid}" style="${base}display:flex;align-items:flex-end;">${bars}</div>`;
    }
  }
}

function shapeLoop(layer: ShapeLayer, lid: string, start: number, dur: number, k: number, accents: number[] = [], strength = 0.6): string[] {
  // Music accents (markers): bars hit on each marker and decay; other shapes flash brighter.
  if (accents.length) {
    const out: string[] = [];
    accents.forEach((t, i) => {
      const gap = (accents[i + 1] ?? t + 0.5) - t;
      const d = f3(Math.max(0.08, Math.min(0.45, gap * 0.8)));
      if (layer.shape === "bars") out.push(`tl.fromTo("#${lid} .bar",{scaleY:1},{scaleY:${f3(1 - 0.65 * strength)},duration:${d},ease:"power2.out",stagger:{each:0.012,from:"center"},immediateRender:false},${f3(t)});`);
      else out.push(`tl.fromTo("#${lid}",{filter:"brightness(${f3(1 + 1.2 * strength)})"},{filter:"brightness(1)",duration:${d},ease:"power2.out",immediateRender:false},${f3(t)});`);
    });
    if (layer.shape === "bars" || layer.animation.loop === "none") return out;
    return [...out, ...shapeLoop({ ...layer, shape: layer.shape }, lid, start, dur, k)];
  }
  const loop = layer.animation.loop;
  if (loop === "none" && layer.shape !== "bars" && layer.shape !== "line") return [];
  if (layer.shape === "line") return [`tl.fromTo("#${lid} .shape-inner",{scaleX:0},{scaleX:1,duration:${f3(Math.min(dur * 0.6, 1.2))},ease:"power2.out"},${start});`];
  if (layer.shape === "bars") {
    const beats = Math.max(1, Math.floor(dur / 0.5));
    return [`tl.fromTo("#${lid} .bar",{scaleY:0.35},{scaleY:1,duration:0.25,ease:"sine.inOut",yoyo:true,repeat:${beats * 2 - 1},stagger:{each:0.04,from:"center"}},${start});`];
  }
  const period = 1.6 - 0.8 * k;
  const reps = Math.max(0, Math.floor(dur / period) - 1);
  switch (loop) {
    case "pulse":
      return [`tl.fromTo("#${lid} .shape-inner, #${lid}",{scale:1},{scale:${f3(1 + 0.08 + 0.1 * k)},duration:${f3(period / 2)},yoyo:true,repeat:${reps * 2 + 1},ease:"sine.inOut"},${start});`];
    case "spin":
      return [`tl.fromTo("#${lid}",{rotation:0},{rotation:${f3(90 + 180 * k)},duration:${dur},ease:"none"},${start});`];
    case "drift":
      return [`tl.fromTo("#${lid}",{x:0,y:0},{x:${f3(40 * (0.5 + k))},y:${f3(-30 * (0.5 + k))},duration:${dur},ease:"sine.inOut"},${start});`];
    default:
      return [];
  }
}

function backgroundHtml(bg: Background, brand: BrandSnapshot, ctx: CompileContext, sid: string, start: number, dur: number, warnings: string[]): string {
  switch (bg.type) {
    case "color":
      return `<div class="bg" style="background:${resolveColor(brand, bg.color, "#000000")};"></div>`;
    case "gradient":
      return `<div class="bg" style="background:linear-gradient(${bg.angle}deg, ${resolveColor(brand, bg.from, "#000000")}, ${resolveColor(brand, bg.to, "#222222")});"></div>`;
    case "asset": {
      const a = ctx.assets.get(bg.assetId);
      if (!a) {
        warnings.push("A background image is missing; the brand background colour is used.");
        return `<div class="bg" style="background:${resolveColor(brand, "brand.background", "#000000")};"></div>`;
      }
      const media =
        a.kind === "video"
          ? `<video id="${sid}-bgimg" src="${a.file}" muted playsinline data-start="${start}" data-duration="${f3(Math.min(dur, a.durationSec ?? dur))}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;${bg.blur ? `filter:blur(${bg.blur}px);` : ""}"></video>`
          : `<img id="${sid}-bgimg" src="${a.file}" alt="" style="${bg.blur ? `filter:blur(${bg.blur}px);` : ""}">`;
      return `<div class="bg" style="background:#000;">${media}<div style="position:absolute;inset:0;background:rgba(0,0,0,${bg.dim});"></div></div>`;
    }
  }
}
