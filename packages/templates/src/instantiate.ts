import {
  computeTimeline,
  CreativeProfileSnapshot,
  DOCUMENT_SCHEMA_VERSION,
  ProjectDocument,
  secondsToFrames,
  syncProgramScenes,
  type AspectRatio,
  type AudioTrack,
  type BrandSnapshot,
  type Layer,
  type Scene,
} from "@vs/domain";
import type { LayerRecipe, SceneRecipe, TemplateDefinition } from "./types";

export type InputValue = string | number | boolean | string[];
export type InputValues = Record<string, InputValue | undefined>;

export interface InstantiateOptions {
  title: string;
  aspect?: AspectRatio;
  brand: BrandSnapshot;
  profile?: Partial<CreativeProfileSnapshot>;
  inputs: InputValues;
  durationSec?: number;
  /** Deterministic id generator (tests) or random (app). */
  newId: (prefix: string) => string;
  seed?: number;
  /** Program engine: probed duration of the source recording. */
  sourceDurationSec?: number;
}

const BINDING = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)(?:\.([a-zA-Z_]+))?(?:\[(\d+|i)\])?\s*\}\}/g;

/** Resolve "{{x}}" bindings. Pure string substitution — nothing is evaluated. */
export function bind(template: string, inputs: InputValues, brand: BrandSnapshot, extra: Record<string, string> = {}): string {
  return template
    .replace(BINDING, (_, name: string, prop: string | undefined, idx: string | undefined) => {
      if (name === "brand" && prop === "name") return brand.name;
      if (name in extra) return extra[name] ?? "";
      const v = inputs[name];
      if (v === undefined || v === null) return "";
      // "[i]" indexes by the current repeat index (repeatFor scenes).
      const n = idx === "i" ? Number(extra.index0 ?? 0) : idx !== undefined ? Number(idx) : undefined;
      if (Array.isArray(v)) return n !== undefined ? (v[n] ?? "") : v.join(", ");
      return String(v);
    })
    .replace(/[ \t]+/g, " ")
    .trim();
}

function hasValue(v: InputValue | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.some((x) => String(x).trim().length > 0);
  return String(v).trim().length > 0;
}

export function missingRequiredInputs(def: TemplateDefinition, inputs: InputValues): string[] {
  return def.inputs.filter((f) => f.required && !hasValue(inputs[f.id])).map((f) => f.label);
}

/**
 * Deterministic, non-AI instantiation: fills a template's scene recipe from the
 * user's inputs. The Claude planner improves on this, but this path keeps manual
 * workflows usable without credentials.
 */
export function instantiateTemplate(def: TemplateDefinition, opts: InstantiateOptions): ProjectDocument {
  const inputs: InputValues = { ...Object.fromEntries(def.inputs.filter((f) => f.default !== undefined).map((f) => [f.id, f.default as InputValue])), ...opts.inputs };
  const aspect = opts.aspect ?? def.defaultAspect;
  const fps = 30;
  const brand = opts.brand;

  // Approved facts: every item in a "facts" input and benefits become owner-approved claims.
  const approvedFacts: ProjectDocument["brief"]["approvedFacts"] = [];
  const factIdFor = new Map<string, string>();
  for (const f of def.inputs.filter((x) => x.kind === "facts")) {
    const v = inputs[f.id];
    const list = Array.isArray(v) ? v : typeof v === "string" && v ? v.split("\n") : [];
    list
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((text, i) => {
        const id = `fact-${f.id}-${i}`;
        approvedFacts.push({ id, text, approved: true });
        factIdFor.set(`${f.id}[${i}]`, id);
      });
  }

  const scenes: Scene[] = [];
  for (const recipe of def.scenes) {
    if (recipe.when && !hasValue(inputs[recipe.when])) continue;
    const items = recipe.repeatFor ? listOf(inputs[recipe.repeatFor]) : [undefined];
    items.forEach((item, idx) => {
      const extra: Record<string, string> = item !== undefined ? { item, index: String(idx + 1), index0: String(idx), count: String(items.length) } : {};
      scenes.push(buildScene(recipe, inputs, brand, extra, factIdFor, opts.newId, fps, recipe.repeatFor ? idx : undefined));
    });
  }
  if (scenes.length === 0) throw new Error(`Template ${def.id} produced no scenes for these inputs.`);
  scenes[0]!.transitionIn = { type: "cut", durationFrames: 0 };

  const profile = CreativeProfileSnapshot.parse({ ...def.profile, ...opts.profile });
  const audio: AudioTrack[] = [];
  const musicInput = def.audio.musicInput;
  const musicAsset = musicInput ? firstString(inputs[musicInput]) : undefined;
  const narrationAsset = def.audio.narrationInput ? firstString(inputs[def.audio.narrationInput]) : undefined;
  if (narrationAsset) {
    audio.push({
      id: opts.newId("trk"),
      kind: "voiceover",
      assetId: narrationAsset,
      anchor: { type: "absolute", startFrame: 0 },
      sourceInSec: 0,
      sourceOutSec: null,
      gainDb: 0,
      fadeInFrames: 0,
      fadeOutFrames: 6,
      duck: { enabled: false, amountDb: -12 },
    });
  }
  if (musicAsset) {
    audio.push({
      id: opts.newId("trk"),
      kind: "music",
      assetId: musicAsset,
      anchor: { type: "absolute", startFrame: 0 },
      sourceInSec: typeof inputs.musicStartSec === "number" ? inputs.musicStartSec : Number(inputs.musicStartSec ?? 0) || 0,
      sourceOutSec: null,
      gainDb: def.audio.musicGainDb,
      fadeInFrames: 0,
      fadeOutFrames: 45,
      duck: { enabled: true, amountDb: def.audio.duckDb },
    });
  }

  const doc = ProjectDocument.parse({
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    title: opts.title,
    template: { templateId: def.id, version: def.version, family: def.family, preset: def.preset },
    format: { aspect, fps, safeArea: aspect === "9:16" && def.family === "vertical-short" ? "reels-shorts@2026-09" : "none@1" },
    brand,
    profile,
    brief: {
      productName: str(inputs.productName),
      promise: str(inputs.promise),
      audience: str(inputs.audience),
      objective: str(inputs.objective),
      tone: str(inputs.tone),
      cta: str(inputs.cta),
      destinationUrl: str(inputs.destinationUrl),
      benefits: listOf(inputs.benefits).slice(0, 6),
      approvedFacts,
      notes: str(inputs.notes),
      inputs: Object.fromEntries(Object.entries(inputs).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean | string[]>,
    },
    scenes,
    audio,
    captions: { enabled: def.audio.captions },
    musicLock: { enabled: def.audio.musicLocked && !!musicAsset, trackId: audio[0]?.id },
    seed: opts.seed ?? 1,
  });

  if (def.engine === "program") return withProgram(def, doc, inputs, opts);

  const target = opts.durationSec ?? (typeof inputs.durationSec === "number" ? inputs.durationSec : Number(inputs.durationSec) || undefined);
  return target ? fitDuration(doc, clamp(target, def.duration.minSec, def.duration.maxSec)) : doc;
}

/**
 * Talking-head documents start as the untouched source: one presenter scene covering the
 * whole recording and an EDL that keeps everything. Sections, captions and overlays are
 * built once the transcript exists (buildProgramScenes); cuts are separate opt-in edits.
 */
function withProgram(def: TemplateDefinition, doc: ProjectDocument, inputs: InputValues, opts: InstantiateOptions): ProjectDocument {
  const cfg = def.program;
  if (!cfg) throw new Error(`Template ${def.id} uses the program engine without a program config.`);
  const sourceAssetId = firstString(inputs[cfg.sourceInput]);
  if (!sourceAssetId) throw new Error("A source recording is required.");
  const dur = opts.sourceDurationSec;
  if (!dur || dur <= 0) throw new Error("The source recording's duration is unknown; wait for it to finish processing.");
  const first = doc.scenes[0]!;
  const next = ProjectDocument.parse({
    ...doc,
    scenes: [{ ...first, sourceRange: { startSec: 0, endSec: dur }, durationFrames: Math.max(1, Math.round(dur * 30)), transitionIn: { type: "cut", durationFrames: 0 } }],
    program: {
      sourceAssetId,
      edl: [{ id: opts.newId("edl"), sourceAssetId, sourceInSec: 0, sourceOutSec: dur, reason: "source", review: "accepted" }],
      proposedCuts: [],
      presenterFraming: cfg.presenterFraming,
      style: cfg.style,
    },
  });
  return syncProgramScenes(next);
}

function buildScene(
  recipe: SceneRecipe,
  inputs: InputValues,
  brand: BrandSnapshot,
  extra: Record<string, string>,
  factIdFor: Map<string, string>,
  newId: (p: string) => string,
  fps: number,
  repeatIndex: number | undefined,
): Scene {
  const sceneId = newId("scn");
  const layers: Layer[] = [];
  recipe.layers.forEach((lr, i) => {
    const layer = buildLayer(lr, `${sceneId}-l${i}`, inputs, brand, extra, factIdFor, fps, repeatIndex);
    if (layer) layers.push(layer);
  });
  return {
    id: sceneId,
    purpose: bind(recipe.purpose, inputs, brand, extra) || recipe.slot,
    recipeSlot: recipe.slot,
    durationFrames: secondsToFrames(recipe.durationSec, fps),
    locked: false,
    layout: recipe.layout,
    background: recipe.background,
    transitionIn: recipe.transition,
    motionIntensity: recipe.motion,
    layers,
    script: { narration: bind(recipe.narration, inputs, brand, extra) },
    notes: "",
    status: { state: layers.some((l) => (l.kind === "image" || l.kind === "video") && !l.assetId) ? "needs_input" : "ready", message: "" },
  };
}

function buildLayer(
  lr: LayerRecipe,
  id: string,
  inputs: InputValues,
  brand: BrandSnapshot,
  extra: Record<string, string>,
  factIdFor: Map<string, string>,
  fps: number,
  repeatIndex: number | undefined,
): Layer | null {
  switch (lr.kind) {
    case "text": {
      const text = bind(lr.text, inputs, brand, extra);
      if (!text && lr.optional) return null;
      let approvedFactId: string | undefined;
      if (lr.factFrom) {
        const key = lr.factFrom.replace("{{index0}}", String(repeatIndex ?? 0));
        approvedFactId = factIdFor.get(key);
      }
      return {
        id,
        kind: "text",
        slot: lr.slot,
        role: lr.role,
        text,
        approvedFactId,
        hidden: false,
        style: { scale: lr.scale, color: lr.color, backing: lr.backing, uppercase: lr.uppercase },
        animation: { in: lr.animation, delayFrames: secondsToFrames(lr.delaySec, fps), stagger: lr.stagger },
      };
    }
    case "image": {
      const assetId = bind(lr.asset, inputs, brand, extra) || null;
      if (!assetId && lr.optional) return null;
      return {
        id,
        kind: "image",
        slot: lr.slot,
        assetId,
        fit: lr.fit,
        focal: { x: 0.5, y: 0.5 },
        frame: lr.frame,
        alt: bind(lr.alt, inputs, brand, extra),
        hidden: false,
        animation: { in: lr.animation, delayFrames: secondsToFrames(lr.delaySec, fps), kenBurns: lr.kenBurns },
      };
    }
    case "video": {
      const assetId = bind(lr.asset, inputs, brand, extra) || null;
      if (!assetId && lr.optional) return null;
      return {
        id,
        kind: "video",
        slot: lr.slot,
        assetId,
        sourceInSec: 0,
        sourceOutSec: null,
        muted: lr.muted,
        fit: lr.fit,
        focal: { x: 0.5, y: 0.5 },
        frame: lr.frame,
        hidden: false,
        animation: { in: lr.animation, delayFrames: 0, punchIn: 1 },
      };
    }
    case "shape":
      return {
        id,
        kind: "shape",
        slot: lr.slot,
        shape: lr.shape,
        color: lr.color,
        box: lr.box,
        hidden: false,
        animation: { in: lr.animation, delayFrames: secondsToFrames(lr.delaySec, fps), loop: lr.loop },
      };
    case "graphics":
      return { id, kind: "graphics", slot: lr.slot, backend: lr.backend, component: lr.component, componentVersion: lr.componentVersion, params: lr.params, seed: 1, hidden: false };
  }
}

/** Scale unlocked scene durations so the timeline hits the target length. */
export function fitDuration(doc: ProjectDocument, targetSec: number): ProjectDocument {
  const fps = doc.format.fps;
  const target = secondsToFrames(targetSec, fps);
  const current = computeTimeline(doc).totalFrames;
  const adjustable = doc.scenes.filter((s) => !s.locked);
  const adjustableFrames = adjustable.reduce((a, s) => a + s.durationFrames, 0);
  if (current === target || adjustableFrames === 0) return doc;
  const ratio = (adjustableFrames + (target - current)) / adjustableFrames;
  const next = structuredClone(doc);
  let assigned = 0;
  const adj = next.scenes.filter((s) => !s.locked);
  adj.forEach((s, i) => {
    if (i === adj.length - 1) {
      s.durationFrames = Math.max(fps, adjustableFrames + (target - current) - assigned);
    } else {
      s.durationFrames = Math.max(fps, Math.round(s.durationFrames * ratio));
      assigned += s.durationFrames;
    }
  });
  return ProjectDocument.parse(next);
}

function listOf(v: InputValue | undefined): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split("\n").map((s) => s.trim()).filter(Boolean);
  return [];
}
function firstString(v: InputValue | undefined): string | undefined {
  return listOf(v)[0];
}
function str(v: InputValue | undefined): string {
  return v === undefined ? "" : Array.isArray(v) ? v.join(", ") : String(v);
}
function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}
