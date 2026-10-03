import { framesToSeconds, type ProjectDocument } from "@vs/domain";
import { instantiateTemplate, type InputValues } from "./instantiate";
import { TemplateDefinition, type InputField, type LayerRecipe, type SceneRecipe } from "./types";
import { DEFAULT_BRAND } from "./brand";

export interface SaveTemplateOptions {
  name: string;
  description: string;
  /** Text layers ("sceneId/layerId") that become variables; all other text stays literal. */
  textVariables: { sceneId: string; layerId: string; label?: string }[];
  /** Asset ids the owner explicitly chose to package. Everything else becomes an empty slot. */
  includeAssetIds: string[];
  source: { projectId: string; revisionId: string };
}

export interface SaveTemplateResult {
  definition: TemplateDefinition;
  variables: { inputId: string; label: string; kind: InputField["kind"]; defaultValue?: string }[];
  packagedAssetIds: string[];
}

function slugId(s: string) {
  return s.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "value";
}

/**
 * FR-11: keep layout, motion, timing and audio rules; replace selected text with
 * variables and every non-selected asset with a named slot, so private media is not
 * baked into the template.
 */
export function templateFromProject(doc: ProjectDocument, opts: SaveTemplateOptions): SaveTemplateResult {
  const include = new Set(opts.includeAssetIds);
  const inputs: InputField[] = [];
  const pushInput = (f: Omit<InputField, "help" | "required" | "variable"> & Partial<InputField>) => inputs.push({ help: "", required: false, variable: true, ...f } as InputField);
  const variables: SaveTemplateResult["variables"] = [];
  const used = new Set<string>();
  const uniq = (base: string) => {
    let id = base;
    let i = 2;
    while (used.has(id)) id = `${base}_${i++}`;
    used.add(id);
    return id;
  };
  const selected = new Map(opts.textVariables.map((v) => [`${v.sceneId}/${v.layerId}`, v]));
  const assetInput = new Map<string, string>(); // original asset -> input id (shared when reused)

  const assetBinding = (assetId: string | null, label: string, kind: "image" | "video" | "audio"): string => {
    if (!assetId) {
      const id = uniq(slugId(label).toLowerCase());
      pushInput({ id, label, kind, required: false, help: "Empty slot in the original project.", variable: true });
      variables.push({ inputId: id, label, kind });
      return `{{${id}}}`;
    }
    if (include.has(assetId)) return assetId;
    if (assetId === doc.brand.logoAssetId) {
      // The brand logo becomes the template's standard "logo" input, not a generic slot.
      if (!used.has("logo")) {
        used.add("logo");
        pushInput({ id: "logo", label: "Logo", kind: "image", help: "Shown wherever the original used its logo." });
        variables.push({ inputId: "logo", label: "Logo", kind: "image" });
      }
      return "{{logo}}";
    }
    const existing = assetInput.get(assetId);
    if (existing) return `{{${existing}}}`;
    const id = uniq(slugId(label).toLowerCase());
    assetInput.set(assetId, id);
    pushInput({ id, label, kind, required: false, help: "Replaceable media slot.", variable: true });
    variables.push({ inputId: id, label, kind });
    return `{{${id}}}`;
  };

  const scenes: SceneRecipe[] = doc.scenes.map((scene, si) => {
    const layers: LayerRecipe[] = [];
    for (const l of scene.layers) {
      if (l.hidden) continue;
      const delaySec = "animation" in l && "delayFrames" in l.animation ? framesToSeconds(l.animation.delayFrames, doc.format.fps) : 0;
      switch (l.kind) {
        case "text": {
          const v = selected.get(`${scene.id}/${l.id}`);
          let text = l.text;
          let factFrom: string | undefined;
          if (v) {
            const label = v.label ?? `${scene.purpose} — ${l.role}`;
            if (l.approvedFactId) {
              const id = uniq(`fact_${slugId(label).toLowerCase()}`);
              pushInput({ id, label: `${label} (approved claim)`, kind: "facts", maxItems: 1, required: false, default: [l.text], variable: true, help: "Shown verbatim as an approved claim." });
              variables.push({ inputId: id, label, kind: "facts", defaultValue: l.text });
              text = `{{${id}[0]}}`;
              factFrom = `${id}[0]`;
            } else {
              const id = uniq(slugId(label).toLowerCase());
              pushInput({ id, label, kind: l.text.length > 80 ? "longtext" : "text", required: false, default: l.text, variable: true });
              variables.push({ inputId: id, label, kind: "text", defaultValue: l.text });
              text = `{{${id}}}`;
            }
          }
          layers.push({ kind: "text", slot: l.slot, role: l.role, text, factFrom, optional: !!v, scale: l.style.scale, color: l.style.color, backing: l.style.backing, animation: l.animation.in, delaySec, stagger: l.animation.stagger, uppercase: l.style.uppercase });
          break;
        }
        case "image":
          layers.push({ kind: "image", slot: l.slot, asset: assetBinding(l.assetId, `${scene.purpose} image${l.slot !== "media" ? ` (${l.slot})` : ""}`, "image"), optional: true, fit: l.fit, frame: l.frame, animation: l.animation.in, delaySec, kenBurns: l.animation.kenBurns, alt: l.alt });
          break;
        case "video":
          layers.push({ kind: "video", slot: l.slot, asset: assetBinding(l.assetId, `${scene.purpose} video`, "video"), optional: true, fit: l.fit, frame: l.frame, muted: l.muted, animation: l.animation.in });
          break;
        case "shape":
          layers.push({ kind: "shape", slot: l.slot, shape: l.shape, color: l.color, animation: l.animation.in, loop: l.animation.loop, delaySec, box: l.box });
          break;
        case "graphics": {
          // An image a graphics effect uses (the glass lens's picture) is private media like any
          // other: it becomes a replaceable slot, never the original asset.
          const params = Object.fromEntries(Object.entries(l.params).map(([k, v]) => [k, typeof v === "string" && /^ast_[A-Za-z0-9_]+$/.test(v) ? assetBinding(v, `${scene.purpose} effect image`, "image") : v]));
          layers.push({ kind: "graphics", slot: l.slot, backend: l.backend, component: l.component, componentVersion: l.componentVersion, params, optional: true, seed: l.seed, ...(l.box ? { box: l.box } : {}) });
          break;
        }
      }
    }
    let background = scene.background;
    if (background.type === "asset" && !include.has(background.assetId)) {
      background = { type: "color", color: "brand.background" };
    }
    return {
      slot: `${slugId(scene.recipeSlot || `scene${si + 1}`)}_${si + 1}`.slice(0, 40),
      purpose: scene.purpose,
      durationSec: framesToSeconds(scene.durationFrames, doc.format.fps),
      layout: scene.layout,
      transition: scene.transitionIn,
      background,
      motion: scene.motionIntensity,
      narration: scene.script.narration,
      layers,
    };
  });

  // Audio rules: keep gain/ducking; replace the music file with a slot unless packaged.
  const music = doc.audio.find((t) => t.kind === "music");
  let musicInput: string | undefined;
  if (music) {
    if (include.has(music.assetId)) {
      musicInput = uniq("music");
      pushInput({ id: musicInput, label: "Music track", kind: "audio", required: false, default: music.assetId, variable: true });
    } else {
      musicInput = uniq("music");
      pushInput({ id: musicInput, label: "Music track", kind: "audio", required: false, variable: true, help: "The original track is not included." });
      variables.push({ inputId: musicInput, label: "Music track", kind: "audio" });
    }
  }
  if (!inputs.some((i) => i.id === "logo")) {
    used.add("logo");
    pushInput({ id: "logo", label: "Logo", kind: "image", required: false, variable: true });
    variables.push({ inputId: "logo", label: "Logo", kind: "image" });
  }
  const totalSec = framesToSeconds(doc.scenes.reduce((a, s) => a + s.durationFrames, 0), doc.format.fps);
  const definition = TemplateDefinition.parse({
    id: "u-pending",
    family: doc.template.family,
    preset: doc.template.preset,
    name: opts.name,
    description: opts.description,
    version: 1,
    tags: { purpose: ["custom"], generatedMedia: "none" },
    defaultAspect: doc.format.aspect,
    supportedAspects: ["16:9", "9:16", "1:1"],
    duration: { minSec: Math.max(5, Math.floor(totalSec * 0.5)), maxSec: Math.ceil(totalSec * 2), defaultSec: Math.round(totalSec) },
    inputs,
    scenes,
    profile: doc.profile,
    audio: { musicInput, musicGainDb: music?.gainDb ?? -8, duckDb: music?.duck.amountDb ?? -12, narration: "optional", captions: doc.captions.enabled, musicLocked: doc.musicLock.enabled },
    providers: { required: [], optional: ["planner"] },
    plannerGuidance: `Custom template saved from "${doc.title}". Keep the scene order and layouts; fill variables from the new brief. Never invent claims.`,
    checklist: ["Every variable is filled or deliberately left empty", "No media from the original project appears unless it was packaged"],
    derivedFrom: opts.source,
  });
  return { definition, variables, packagedAssetIds: [...include] };
}

/**
 * Hidden-dependency check: instantiate the template with sample values and make sure the
 * resulting project references no asset from the original project except packaged ones.
 */
export function checkTemplateIndependence(def: TemplateDefinition, originalDoc: ProjectDocument, packaged: string[], sampleInputs: InputValues = {}) {
  let n = 0;
  const doc = instantiateTemplate(def, { title: "Reuse check", brand: DEFAULT_BRAND, inputs: sampleInputs, newId: (p) => `${p}${++n}` });
  const allowed = new Set([...packaged, ...Object.values(sampleInputs).flatMap((v) => (Array.isArray(v) ? v : [String(v)]))]);
  const originalAssets = new Set<string>();
  const collect = (d: ProjectDocument, into: Set<string>) => {
    for (const s of d.scenes) {
      if (s.background.type === "asset") into.add(s.background.assetId);
      for (const l of s.layers) if ((l.kind === "image" || l.kind === "video") && l.assetId) into.add(l.assetId);
    }
    for (const t of d.audio) into.add(t.assetId);
  };
  collect(originalDoc, originalAssets);
  const used = new Set<string>();
  collect(doc, used);
  const leaks = [...used].filter((a) => originalAssets.has(a) && !allowed.has(a));
  return { ok: leaks.length === 0, leaks, preview: doc };
}
