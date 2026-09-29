import { z } from "zod";
import { AspectRatio, Background, ColorRef, CreativeProfileSnapshot, EntranceAnimation, Transition } from "@vs/domain";

/** Capabilities a template may require. Used to show provider requirements before work starts. */
export const Capability = z.enum([
  "planner", // Claude planning/editing
  "tts",
  "transcription",
  "image-generation",
  "video-generation",
  "segmentation",
  "graphics-redraw",
  "graphics-skia",
]);
export type Capability = z.infer<typeof Capability>;

export const InputField = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/),
  label: z.string().max(80),
  kind: z.enum(["text", "longtext", "list", "url", "image", "images", "audio", "video", "videos", "subtitle", "select", "number", "facts"]),
  required: z.boolean().default(false),
  help: z.string().max(300).default(""),
  maxLength: z.number().int().positive().optional(),
  maxItems: z.number().int().positive().optional(),
  options: z.array(z.string().max(60)).optional(),
  default: z.union([z.string().max(2000), z.number(), z.array(z.string().max(400))]).optional(),
  /** Set on saved templates: the value came from the original project and is a replaceable variable. */
  variable: z.boolean().default(false),
});
export type InputField = z.infer<typeof InputField>;

/**
 * Bindings use a tiny, non-executable substitution language:
 * "{{inputId}}", "{{inputId[0]}}", "{{brand.name}}". Unknown bindings resolve to "".
 */
export const LayerRecipe = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    slot: z.string(),
    role: z.enum(["kicker", "headline", "subhead", "body", "label", "cta", "stat", "caption", "quote"]),
    text: z.string().max(600),
    /** Bind to the approved fact whose text this becomes. */
    factFrom: z.string().optional(),
    optional: z.boolean().default(false),
    scale: z.number().min(0.4).max(2.5).default(1),
    color: ColorRef.optional(),
    backing: z.enum(["none", "solid", "translucent"]).default("none"),
    animation: EntranceAnimation.default("rise"),
    delaySec: z.number().min(0).default(0),
    stagger: z.boolean().default(false),
    uppercase: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("image"),
    slot: z.string(),
    asset: z.string().max(200),
    optional: z.boolean().default(false),
    fit: z.enum(["cover", "contain"]).default("contain"),
    frame: z.enum(["none", "card", "laptop", "phone", "circle", "rounded"]).default("none"),
    animation: EntranceAnimation.default("fade"),
    delaySec: z.number().min(0).default(0),
    kenBurns: z.boolean().default(false),
    alt: z.string().max(300).default(""),
  }),
  z.object({
    kind: z.literal("video"),
    slot: z.string(),
    asset: z.string().max(200),
    optional: z.boolean().default(false),
    fit: z.enum(["cover", "contain"]).default("cover"),
    frame: z.enum(["none", "card", "laptop", "phone", "circle", "rounded"]).default("none"),
    muted: z.boolean().default(true),
    animation: EntranceAnimation.default("fade"),
  }),
  z.object({
    kind: z.literal("shape"),
    slot: z.string(),
    shape: z.enum(["rect", "circle", "ring", "line", "blob", "grid", "bars"]),
    color: ColorRef.default("brand.accent"),
    animation: EntranceAnimation.default("pop"),
    loop: z.enum(["none", "pulse", "spin", "drift"]).default("none"),
    delaySec: z.number().min(0).default(0),
    box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
  }),
  z.object({
    kind: z.literal("character"),
    slot: z.string(),
    pose: z.enum(["idle", "wave", "jump", "think", "celebrate", "point", "walk"]).default("idle"),
    accessory: z.enum(["none", "hat", "cape", "glasses", "crown", "helmet"]).default("none"),
    facing: z.enum(["left", "right"]).default("right"),
    scale: z.number().min(0.2).max(3).default(1),
    animation: EntranceAnimation.default("pop"),
    delaySec: z.number().min(0).default(0),
  }),
  z.object({
    kind: z.literal("graphics"),
    slot: z.string(),
    backend: z.enum(["redraw", "skia"]),
    component: z.string(),
    componentVersion: z.number().int().positive(),
    params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
    optional: z.boolean().default(true),
    box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
  }),
]);
export type LayerRecipe = z.infer<typeof LayerRecipe>;

export const SceneRecipe = z.object({
  slot: z.string().max(40),
  purpose: z.string().max(80),
  durationSec: z.number().positive().max(120),
  layout: z.string(),
  transition: Transition.default({ type: "cut", durationFrames: 0 }),
  background: Background,
  motion: z.number().min(0).max(1).default(0.6),
  /** Include the scene only when this input has a value (e.g. omit "proof" without proof). */
  when: z.string().optional(),
  /** Repeat the scene once per item of a list input; "{{item}}" and "{{index}}" bind inside. */
  repeatFor: z.string().optional(),
  narration: z.string().max(1200).default(""),
  layers: z.array(LayerRecipe).max(24),
  /** Footage shot (T7/P6): generated from the prompt or filled with supplied footage. */
  shot: z
    .object({
      kind: z.enum(["image", "video"]).default("video"),
      prompt: z.string().max(1500),
      continuity: z.string().max(500).default(""),
      reference: z.string().max(200).optional(),
      /** Input holding supplied footage, consumed in shot order. */
      suppliedFrom: z.string().optional(),
    })
    .optional(),
});
export type SceneRecipe = z.infer<typeof SceneRecipe>;

export const TemplateDefinition = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
  family: z.enum(["motion-reel", "mascot-story", "product-launch", "vertical-short", "talking-head", "music-video", "anime-opening"]),
  preset: z.string().max(40).optional(),
  name: z.string().max(80),
  description: z.string().max(600),
  version: z.number().int().positive(),
  tags: z.object({
    purpose: z.array(z.string().max(40)).max(8),
    generatedMedia: z.enum(["none", "optional", "required"]),
  }),
  defaultAspect: AspectRatio,
  supportedAspects: z.array(AspectRatio).min(1),
  duration: z.object({ minSec: z.number().positive(), maxSec: z.number().positive(), defaultSec: z.number().positive() }),
  inputs: z.array(InputField).max(40),
  scenes: z.array(SceneRecipe).min(1).max(60),
  profile: CreativeProfileSnapshot.partial().default({}),
  audio: z
    .object({
      musicInput: z.string().optional(),
      /** Uploaded full narration input (replaces per-scene synthesis). */
      narrationInput: z.string().optional(),
      musicGainDb: z.number().default(-8),
      duckDb: z.number().default(-12),
      narration: z.enum(["none", "optional", "required"]).default("optional"),
      captions: z.boolean().default(false),
      musicLocked: z.boolean().default(false),
    })
    .default({ musicGainDb: -8, duckDb: -12, narration: "optional", captions: false, musicLocked: false }),
  providers: z.object({ required: z.array(Capability).default([]), optional: z.array(Capability).default([]) }).default({ required: [], optional: [] }),
  /** Authored guidance supplied to the planner as data; never executed. */
  plannerGuidance: z.string().max(4000).default(""),
  checklist: z.array(z.string().max(200)).max(20).default([]),
  /** Workflow engine the family uses beyond scene recipes. */
  engine: z.enum(["scenes", "program", "shots", "collection"]).default("scenes"),
  /** Program engine (talking head): which input is the recording, which the optional subtitle file, and the style treatment. */
  program: z
    .object({
      sourceInput: z.string(),
      transcriptInput: z.string().optional(),
      bRollInput: z.string().optional(),
      style: z.enum(["presenter-intro", "whiteboard", "course", "social", "balanced"]).default("balanced"),
      presenterFraming: z.enum(["full", "split-right", "split-left", "rounded-inset", "hidden"]).default("full"),
    })
    .optional(),
  /** Mascot story (T2): which inputs define the persistent character reference. */
  character: z.object({ nameInput: z.string(), imageInput: z.string().optional(), speciesInput: z.string().optional(), colorInput: z.string().optional() }).optional(),
  /** Shots engine (T7/P6): character reference input and default shot notes. */
  shots: z.object({ charactersInput: z.string().optional(), characterImagesInput: z.string().optional() }).optional(),
  /** Music-video engine (T6): which inputs hold the song and the selected excerpt. */
  musicVideo: z.object({ songInput: z.string(), inInput: z.string(), outInput: z.string(), lyricsInput: z.string().optional(), motifInput: z.string().optional() }).optional(),
  /** Present on templates saved from projects. */
  derivedFrom: z.object({ projectId: z.string(), revisionId: z.string() }).optional(),
});
export type TemplateDefinition = z.infer<typeof TemplateDefinition>;
export type TemplateDefinitionInput = z.input<typeof TemplateDefinition>;
