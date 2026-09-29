import { z } from "zod";
import { AspectRatio, SafeAreaPresetIdSchema } from "./format";

/**
 * Project document schema. Every revision stores one validated document.
 * Text fields are data only — nothing here is ever evaluated as code.
 */
export const DOCUMENT_SCHEMA_VERSION = 1 as const;

export const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, "invalid id");

/** A colour is either a brand token reference or a literal hex value. */
export const ColorRef = z
  .string()
  .regex(/^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|brand\.(primary|secondary|accent|background|surface|text|muted))$/, "invalid color");
export type ColorRef = z.infer<typeof ColorRef>;

const Frames = z.number().int().nonnegative();
const PositiveFrames = z.number().int().positive();
const Unit = z.number().min(0).max(1);

export const FontRef = z.object({
  family: z.string().min(1).max(80),
  /** Uploaded font asset; when absent the family must be a bundled font. */
  assetId: Id.optional(),
  weight: z.number().int().min(100).max(900).default(700),
});
export type FontRef = z.infer<typeof FontRef>;

export const BrandSnapshot = z.object({
  brandKitId: Id.optional(),
  brandKitVersion: z.number().int().optional(),
  name: z.string().max(120).default(""),
  colors: z.object({
    primary: z.string(),
    secondary: z.string(),
    accent: z.string(),
    background: z.string(),
    surface: z.string(),
    text: z.string(),
    muted: z.string(),
  }),
  fonts: z.object({ heading: FontRef, body: FontRef }),
  logoAssetId: Id.optional(),
  logoPlacement: z.enum(["top-left", "top-right", "bottom-left", "bottom-right", "end-card-only"]).default("end-card-only"),
  captionStyle: z.enum(["clean", "bold", "boxed", "minimal"]).default("boxed"),
  tone: z.string().max(200).default(""),
  forbidden: z.array(z.string().max(200)).max(20).default([]),
});
export type BrandSnapshot = z.infer<typeof BrandSnapshot>;

/** Editing taste, distinct from identity (brand) and structure (template). FR-17. */
export const CreativeProfileSnapshot = z.object({
  profileId: Id.optional(),
  version: z.number().int().optional(),
  name: z.string().max(80).default("Default"),
  pacing: z.enum(["calm", "balanced", "fast"]).default("balanced"),
  typeScale: z.number().min(0.7).max(1.6).default(1),
  transition: z.enum(["cut", "fade", "slide", "wipe", "zoom"]).default("fade"),
  motionIntensity: Unit.default(0.6),
  soundDensity: z.enum(["minimal", "moderate", "rich"]).default("moderate"),
  textDensity: z.enum(["sparse", "balanced", "dense"]).default("balanced"),
  framing: z.enum(["full", "split", "rounded-inset"]).default("full"),
  preferred: z.array(z.string().max(120)).max(20).default([]),
  avoided: z.array(z.string().max(120)).max(20).default([]),
});
export type CreativeProfileSnapshot = z.infer<typeof CreativeProfileSnapshot>;

export const ApprovedFact = z.object({
  id: Id,
  text: z.string().min(1).max(400),
  source: z.string().max(400).optional(),
  sourceDate: z.string().max(40).optional(),
  approved: z.boolean().default(true),
});
export type ApprovedFact = z.infer<typeof ApprovedFact>;

export const Reference = z.object({
  id: Id,
  url: z.string().url().max(2000).optional(),
  assetId: Id.optional(),
  note: z.string().max(1000).default(""),
  /** True only when the content was actually retrieved and read. */
  inspected: z.boolean().default(false),
  inspectionNote: z.string().max(400).optional(),
});

export const Brief = z.object({
  productName: z.string().max(120).default(""),
  promise: z.string().max(300).default(""),
  audience: z.string().max(300).default(""),
  objective: z.string().max(300).default(""),
  tone: z.string().max(200).default(""),
  cta: z.string().max(120).default(""),
  destinationUrl: z.string().max(500).default(""),
  benefits: z.array(z.string().max(200)).max(6).default([]),
  approvedFacts: z.array(ApprovedFact).max(30).default([]),
  references: z.array(Reference).max(20).default([]),
  notes: z.string().max(4000).default(""),
  /** Template-specific inputs (validated against the template input schema). */
  inputs: z.record(z.string(), z.union([z.string().max(4000), z.number(), z.boolean(), z.array(z.string().max(400)).max(20)])).default({}),
});
export type Brief = z.infer<typeof Brief>;

export const EntranceAnimation = z.enum(["none", "fade", "rise", "pop", "slide", "type", "wipe", "draw"]);

/** Normalised frame box; may extend off-canvas for bleeding decoration. */
export const LayerBox = z.object({ x: z.number().min(-1).max(2), y: z.number().min(-1).max(2), w: z.number().positive().max(3), h: z.number().positive().max(3) });

const LayerBase = z.object({
  id: Id,
  /** Layout slot name the compositor resolves per aspect ratio. */
  slot: z.string().max(40),
  /** Optional normalised override box (0..1 of frame), set by direct manipulation. */
  box: LayerBox.optional(),
  hidden: z.boolean().default(false),
});

export const TextLayer = LayerBase.extend({
  kind: z.literal("text"),
  role: z.enum(["kicker", "headline", "subhead", "body", "label", "cta", "stat", "caption", "quote"]),
  text: z.string().max(600),
  approvedFactId: Id.optional(),
  style: z
    .object({
      scale: z.number().min(0.4).max(2.5).default(1),
      color: ColorRef.optional(),
      align: z.enum(["start", "center", "end"]).optional(),
      uppercase: z.boolean().optional(),
      backing: z.enum(["none", "solid", "translucent"]).default("none"),
    })
    .default({ scale: 1, backing: "none" }),
  animation: z
    .object({ in: EntranceAnimation.default("rise"), delayFrames: Frames.default(0), stagger: z.boolean().default(false) })
    .default({ in: "rise", delayFrames: 0, stagger: false }),
});
export type TextLayer = z.infer<typeof TextLayer>;

export const MediaFrame = z.enum(["none", "card", "laptop", "phone", "circle", "rounded"]);

export const ImageLayer = LayerBase.extend({
  kind: z.literal("image"),
  assetId: Id.nullable(),
  /** Stable name of the slot used when saved as a template variable. */
  fit: z.enum(["cover", "contain"]).default("contain"),
  focal: z.object({ x: Unit, y: Unit }).default({ x: 0.5, y: 0.5 }),
  frame: MediaFrame.default("none"),
  characterId: Id.optional(),
  alt: z.string().max(300).default(""),
  animation: z
    .object({ in: EntranceAnimation.default("fade"), delayFrames: Frames.default(0), kenBurns: z.boolean().default(false) })
    .default({ in: "fade", delayFrames: 0, kenBurns: false }),
});
export type ImageLayer = z.infer<typeof ImageLayer>;

export const VideoLayer = LayerBase.extend({
  kind: z.literal("video"),
  assetId: Id.nullable(),
  sourceInSec: z.number().min(0).default(0),
  /** Null means "play until the scene ends". */
  sourceOutSec: z.number().positive().nullable().default(null),
  muted: z.boolean().default(true),
  fit: z.enum(["cover", "contain"]).default("cover"),
  focal: z.object({ x: Unit, y: Unit }).default({ x: 0.5, y: 0.5 }),
  frame: MediaFrame.default("none"),
  animation: z
    .object({ in: EntranceAnimation.default("fade"), delayFrames: Frames.default(0), punchIn: z.number().min(1).max(1.6).default(1) })
    .default({ in: "fade", delayFrames: 0, punchIn: 1 }),
});
export type VideoLayer = z.infer<typeof VideoLayer>;

export const ShapeLayer = LayerBase.extend({
  kind: z.literal("shape"),
  shape: z.enum(["rect", "circle", "ring", "line", "blob", "grid", "bars"]),
  color: ColorRef.default("brand.accent"),
  animation: z
    .object({ in: EntranceAnimation.default("pop"), delayFrames: Frames.default(0), loop: z.enum(["none", "pulse", "spin", "drift"]).default("none") })
    .default({ in: "pop", delayFrames: 0, loop: "none" }),
});
export type ShapeLayer = z.infer<typeof ShapeLayer>;

/** GPU/WASM graphics layer (section 27). Exactly one backend per layer. */
export const GraphicsLayer = LayerBase.extend({
  kind: z.literal("graphics"),
  backend: z.enum(["redraw", "skia"]),
  component: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  componentVersion: z.number().int().positive(),
  params: z.record(z.string().max(40), z.union([z.number(), z.string().max(400), z.boolean()])).default({}),
  seed: z.number().int().default(1),
});
export type GraphicsLayer = z.infer<typeof GraphicsLayer>;

export const Layer = z.discriminatedUnion("kind", [TextLayer, ImageLayer, VideoLayer, ShapeLayer, GraphicsLayer]);
export type Layer = z.infer<typeof Layer>;

export const Background = z.discriminatedUnion("type", [
  z.object({ type: z.literal("color"), color: ColorRef }),
  z.object({ type: z.literal("gradient"), from: ColorRef, to: ColorRef, angle: z.number().min(0).max(360).default(135) }),
  z.object({ type: z.literal("asset"), assetId: Id, dim: Unit.default(0.35), blur: z.number().min(0).max(40).default(0) }),
]);
export type Background = z.infer<typeof Background>;

export const Transition = z.object({
  type: z.enum(["cut", "fade", "slide", "wipe", "zoom"]),
  /** Overlap with the previous scene. Must be 0 for "cut" and for the first scene. */
  durationFrames: Frames,
});
export type Transition = z.infer<typeof Transition>;

export const Scene = z.object({
  id: Id,
  purpose: z.string().max(80),
  /** Recipe slot from the template (e.g. "hook", "reveal", "benefits", "cta"). */
  recipeSlot: z.string().max(40),
  durationFrames: PositiveFrames,
  locked: z.boolean().default(false),
  layout: z.string().max(40),
  background: Background,
  transitionIn: Transition.default({ type: "cut", durationFrames: 0 }),
  motionIntensity: Unit.default(0.6),
  layers: z.array(Layer).max(24),
  script: z.object({ narration: z.string().max(1200).default("") }).default({ narration: "" }),
  notes: z.string().max(1000).default(""),
  /** Frame offset (scene-local) used for the storyboard keyframe. */
  keyframeOffset: Frames.optional(),
  /** Program (talking-head) scenes cover a source-time range; duration follows the EDL. */
  sourceRange: z.object({ startSec: z.number().min(0), endSec: z.number().min(0) }).optional(),
  status: z
    .object({ state: z.enum(["ready", "needs_input", "generating", "failed"]).default("ready"), message: z.string().max(300).default("") })
    .default({ state: "ready", message: "" }),
});
export type Scene = z.infer<typeof Scene>;

export const AudioAnchor = z.discriminatedUnion("type", [
  z.object({ type: z.literal("absolute"), startFrame: Frames }),
  z.object({ type: z.literal("scene"), sceneId: Id, offsetFrames: Frames.default(0) }),
]);
export type AudioAnchor = z.infer<typeof AudioAnchor>;

export const AudioTrack = z.object({
  id: Id,
  kind: z.enum(["music", "voiceover", "source", "sfx"]),
  assetId: Id,
  anchor: AudioAnchor,
  sourceInSec: z.number().min(0).default(0),
  sourceOutSec: z.number().positive().nullable().default(null),
  gainDb: z.number().min(-60).max(12).default(0),
  fadeInFrames: Frames.default(0),
  fadeOutFrames: Frames.default(0),
  /** Music only: lower under voiceover/source speech. */
  duck: z.object({ enabled: z.boolean().default(true), amountDb: z.number().min(-30).max(0).default(-12) }).default({ enabled: true, amountDb: -12 }),
  /** Generated narration records the text hash it was synthesised from, so edits invalidate it. */
  generatedFrom: z.object({ textHash: z.string(), voiceId: z.string(), provider: z.string() }).optional(),
});
export type AudioTrack = z.infer<typeof AudioTrack>;

/** Caption anchors: scene/absolute (frames), or source-media time mapped through the EDL. */
export const CueAnchor = z.discriminatedUnion("type", [
  z.object({ type: z.literal("absolute"), startFrame: Frames }),
  z.object({ type: z.literal("scene"), sceneId: Id, offsetFrames: Frames.default(0) }),
  z.object({ type: z.literal("source"), assetId: Id, startSec: z.number().min(0), endSec: z.number().min(0) }),
]);
export type CueAnchor = z.infer<typeof CueAnchor>;

export const CaptionCue = z.object({
  id: Id,
  text: z.string().max(300),
  anchor: CueAnchor,
  /** Relative to the anchor. */
  startFrame: Frames,
  endFrame: PositiveFrames,
  timing: z.enum(["word", "segment", "estimated", "manual"]).default("segment"),
  words: z.array(z.object({ text: z.string(), startFrame: Frames, endFrame: Frames })).optional(),
});
export type CaptionCue = z.infer<typeof CaptionCue>;

export const Captions = z.object({
  enabled: z.boolean().default(false),
  burnIn: z.boolean().default(true),
  style: z.enum(["clean", "bold", "boxed", "minimal"]).default("boxed"),
  position: z.enum(["bottom", "middle", "top"]).default("bottom"),
  cues: z.array(CaptionCue).max(2000).default([]),
});
export type Captions = z.infer<typeof Captions>;

export const MusicMarker = z.object({
  id: Id,
  /** Absolute project frame; markers stay fixed when scenes ripple. */
  frame: Frames,
  kind: z.enum(["beat", "downbeat", "section"]),
  label: z.string().max(60).default(""),
  /** False when proposed by analysis and not yet confirmed by the user. */
  verified: z.boolean().default(false),
});
export type MusicMarker = z.infer<typeof MusicMarker>;

/** Source-program (talking-head) edit decision list. FR-13. */
export const EdlEntry = z.object({
  id: Id,
  sourceAssetId: Id,
  sourceInSec: z.number().min(0),
  sourceOutSec: z.number().positive(),
  reason: z.string().max(200).default("keep"),
  review: z.enum(["accepted", "proposed", "rejected"]).default("accepted"),
});
export type EdlEntry = z.infer<typeof EdlEntry>;

export const Program = z.object({
  sourceAssetId: Id,
  transcriptId: Id.optional(),
  /** Segments kept, in output order. Cuts are the gaps between them. */
  edl: z.array(EdlEntry).max(2000),
  /** Proposed removals awaiting review (not yet applied). */
  proposedCuts: z
    .array(z.object({ id: Id, sourceInSec: z.number(), sourceOutSec: z.number(), kind: z.enum(["silence", "mistake", "filler"]), reason: z.string().max(300), context: z.string().max(600).default("") }))
    .max(2000)
    .default([]),
  audioFadeMs: z.number().int().min(0).max(200).default(12),
  handlesMs: z.number().int().min(0).max(1000).default(120),
  presenterFraming: z.enum(["full", "split-right", "split-left", "rounded-inset", "hidden"]).default("full"),
  /** Derived (edited) transcript: corrections keyed by immutable source segment id. */
  corrections: z.record(z.string().max(40), z.string().max(2000)).default({}),
  /** Cleanup the owner authorised once for this project; mistakes/retakes always need review. */
  cleanupPolicy: z.object({ autoAcceptSilence: z.boolean().default(false), autoAcceptFillers: z.boolean().default(false) }).default({ autoAcceptSilence: false, autoAcceptFillers: false }),
  /** A24: strict = only owner-specified beats; flexible = assistant may add supporting beats within limits. */
  creativeMode: z.enum(["strict", "flexible"]).default("strict"),
  /** Most beats the assistant may add in flexible mode (each one is also bounded by locks, facts and duration). */
  flexibleBeatLimit: z.number().int().min(0).max(20).default(4),
  /** Style treatment of this variant; siblings share source + transcript, never the document. */
  style: z.enum(["presenter-intro", "whiteboard", "course", "social", "balanced"]).default("balanced"),
});
export type Program = z.infer<typeof Program>;

export const EditorialBeat = z.object({
  id: Id,
  cue: z.object({
    phrase: z.string().max(200),
    occurrence: z.number().int().min(1).default(1),
    sourceStartSec: z.number().min(0).optional(),
    sourceEndSec: z.number().min(0).optional(),
  }),
  message: z.string().max(300).default(""),
  visualAction: z.enum(["label", "logo", "image", "b-roll", "emphasis", "diagram", "zoom", "transition"]).default("label"),
  text: z.string().max(200).default(""),
  assetId: Id.optional(),
  anchor: z.object({ x: Unit, y: Unit }).nullable().default(null),
  anchorLocked: z.boolean().default(false),
  durationFrames: PositiveFrames.default(60),
  emphasis: z.enum(["low", "medium", "high"]).default("medium"),
  backing: z.enum(["solid", "translucent"]).default("translucent"),
  mode: z.enum(["strict", "flexible"]).default("strict"),
  locked: z.boolean().default(false),
  origin: z.enum(["user", "assistant-flexible"]).default("user"),
  status: z.enum(["mapped", "missing", "changed", "unmapped"]).default("unmapped"),
  /** Output frame after mapping through the EDL. */
  outputFrame: Frames.optional(),
});
export type EditorialBeat = z.infer<typeof EditorialBeat>;

export const ProjectDocument = z.object({
  schemaVersion: z.literal(DOCUMENT_SCHEMA_VERSION),
  title: z.string().min(1).max(160),
  template: z.object({ templateId: z.string().max(80), version: z.number().int().positive(), family: z.string().max(40), preset: z.string().max(40).optional() }),
  format: z.object({ aspect: AspectRatio, fps: z.literal(30), safeArea: SafeAreaPresetIdSchema.default("none@1") }),
  brand: BrandSnapshot,
  profile: CreativeProfileSnapshot,
  brief: Brief,
  scenes: z.array(Scene).min(1).max(60),
  audio: z.array(AudioTrack).max(80).default([]),
  captions: Captions.default({ enabled: false, burnIn: true, style: "boxed", position: "bottom", cues: [] }),
  markers: z.array(MusicMarker).max(1000).default([]),
  musicLock: z.object({ enabled: z.boolean(), trackId: Id.optional() }).default({ enabled: false }),
  program: Program.optional(),
  beats: z.array(EditorialBeat).max(200).default([]),
  /** Seed for any procedural variation; part of the render bundle hash. */
  seed: z.number().int().default(1),
});
export type ProjectDocument = z.infer<typeof ProjectDocument>;
export type ProjectDocumentInput = z.input<typeof ProjectDocument>;

export function parseDocument(input: unknown): ProjectDocument {
  return ProjectDocument.parse(input);
}
