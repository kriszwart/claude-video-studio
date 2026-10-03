import { z } from "zod";
import { AspectRatio, SafeAreaPresetIdSchema } from "./format";
import { Script } from "./script";
import { VoiceDirection } from "./voice";

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
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "invalid hex color");

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
  transition: z.enum(["cut", "fade", "slide", "wipe", "zoom", "flythrough", "portal", "fold", "tiles", "colorfield", "glitch"]).default("fade"),
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

export const EntranceAnimation = z.enum(["none", "fade", "rise", "pop", "slide", "type", "wipe", "draw", "scramble", "glitch", "blur"]);

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

export const CountSpec = z.object({
  stops: z.array(z.object({ value: z.number().finite().min(-1e12).max(1e12), atFrames: Frames })).min(2).max(12),
  prefix: z.string().max(8).default(""),
  suffix: z.string().max(12).default(""),
  decimals: z.number().int().min(0).max(2).default(0),
  thousands: z.boolean().default(true),
});
export type CountSpec = z.infer<typeof CountSpec>;

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
  /**
   * A counting number: the text counts from stop to stop, each value reached at its scene-local
   * frame. Every frame shows a real value on the way (formatted, never past a stop, never "-0").
   */
  count: CountSpec.optional(),
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
  shape: z.enum(["rect", "circle", "ring", "line", "blob", "grid", "bars", "scrim"]),
  color: ColorRef.default("brand.accent"),
  animation: z
    .object({ in: EntranceAnimation.default("pop"), delayFrames: Frames.default(0), loop: z.enum(["none", "pulse", "spin", "drift"]).default("none") })
    .default({ in: "pop", delayFrames: 0, loop: "none" }),
});
export type ShapeLayer = z.infer<typeof ShapeLayer>;

/** GPU/WASM graphics layer (section 27). Exactly one backend per layer. */
export const GraphicsLayer = LayerBase.extend({
  kind: z.literal("graphics"),
  backend: z.enum(["redraw", "skia", "three"]),
  component: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  componentVersion: z.number().int().positive(),
  params: z.record(z.string().max(40), z.union([z.number(), z.string().max(400), z.boolean()])).default({}),
  seed: z.number().int().default(1),
});
export type GraphicsLayer = z.infer<typeof GraphicsLayer>;

/** A placement of a project character (T2). The character's look lives in doc.characters. */
export const CharacterLayer = LayerBase.extend({
  kind: z.literal("character"),
  characterId: Id,
  pose: z.enum(["idle", "wave", "jump", "think", "celebrate", "point", "walk"]).default("idle"),
  facing: z.enum(["left", "right"]).default("right"),
  /** Relative size multiplier inside the slot. */
  scale: z.number().min(0.2).max(3).default(1),
  /** Optional costume/era accent colour for this scene (the character stays recognisable). */
  accessory: z.enum(["none", "hat", "cape", "glasses", "crown", "helmet"]).default("none"),
  animation: z.object({ in: EntranceAnimation.default("pop"), delayFrames: Frames.default(0) }).default({ in: "pop", delayFrames: 0 }),
});
export type CharacterLayer = z.infer<typeof CharacterLayer>;

export const Layer = z.discriminatedUnion("kind", [TextLayer, ImageLayer, VideoLayer, ShapeLayer, GraphicsLayer, CharacterLayer]);
export type Layer = z.infer<typeof Layer>;

export const Background = z.discriminatedUnion("type", [
  z.object({ type: z.literal("color"), color: ColorRef }),
  z.object({ type: z.literal("gradient"), from: ColorRef, to: ColorRef, angle: z.number().min(0).max(360).default(135) }),
  z.object({ type: z.literal("asset"), assetId: Id, dim: Unit.default(0.35), blur: z.number().min(0).max(40).default(0) }),
]);
export type Background = z.infer<typeof Background>;

/**
 * Scene transitions. Beyond cut/fade/slide/wipe/zoom, five moves adapted from the motion grammar
 * in motion-video-kit (MIT, © 2026 echris6; distilled from professional launch films):
 * flythrough (the outgoing scene flies past the camera onto the next, already in place), portal
 * (the next scene opens out of a growing circle), fold (the outgoing panel folds away as the next
 * rises), tiles (a tiled chapter break) and colorfield (a brand-colour cloud hands over).
 */
export const TRANSITION_TYPES = ["cut", "fade", "slide", "wipe", "zoom", "flythrough", "portal", "fold", "tiles", "colorfield", "glitch"] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];
export const Transition = z.object({
  type: z.enum(TRANSITION_TYPES),
  /** Overlap with the previous scene. Must be 0 for "cut" and for the first scene. */
  durationFrames: Frames,
});
export type Transition = z.infer<typeof Transition>;

export const FIDELITY_ASPECTS = ["shape", "logo", "label", "colour", "proportions", "details"] as const;
export const ClaudeFidelity = z.object({
  verdict: z.enum(["match", "mismatch", "unsure"]),
  summary: z.string().max(400),
  checks: z.array(z.object({ aspect: z.enum(FIDELITY_ASPECTS), result: z.enum(["ok", "wrong", "unclear", "not-visible"]), note: z.string().max(240) })).max(6),
  /** Frames of the take Claude saw (video: three samples). */
  frames: z.number().int().min(1).max(6),
  model: z.string().max(80).nullable(),
  checkedAt: z.string().max(40),
});
export type ClaudeFidelity = z.infer<typeof ClaudeFidelity>;

/** Measured fidelity review of a generated shot against its approved reference (A23). */
export const ShotReview = z.object({
  referenceAssetId: Id.optional(),
  paletteSimilarity: z.number().min(0).max(1).nullable(),
  flagged: z.boolean(),
  method: z.string().max(300),
  /**
   * Claude's look at the take beside the reference photos: shape, logo, label, colour and
   * proportions. Advisory like the colour measure; the owner still decides.
   */
  claude: ClaudeFidelity.optional(),
  /** Owner decision after looking at it side by side. */
  decision: z.enum(["pending", "approved", "rejected"]).default("pending"),
});
export type ShotReview = z.infer<typeof ShotReview>;

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
  script: z.object({ narration: z.string().max(1200).default(""), direction: VoiceDirection.optional() }).default({ narration: "" }),
  notes: z.string().max(1000).default(""),
  /** Frame offset (scene-local) used for the storyboard keyframe. */
  keyframeOffset: Frames.optional(),
  /**
   * Screen demo: a cursor works the real screenshot in `layerId` while the camera zooms to where
   * the work happens. Steps are points on the screenshot (0–1 of its width/height), reached at
   * `atFrames` (scene-local); the camera zooms in log space, so each doubling takes equal time.
   */
  demo: z
    .object({
      layerId: Id,
      steps: z
        .array(
          z.object({
            x: Unit,
            y: Unit,
            zoom: z.number().min(1).max(4).default(2),
            atFrames: Frames,
            action: z.enum(["click", "move"]).default("click"),
            /** What is clicked, in a few words (shown in the editor and on the sound effect). */
            label: z.string().max(80).default(""),
          }),
        )
        .max(12)
        .default([]),
      /** Pull back to the whole screen at the end. */
      zoomOut: z.boolean().default(true),
    })
    .optional(),
  /** Program (talking-head) scenes cover a source-time range; duration follows the EDL. */
  sourceRange: z.object({ startSec: z.number().min(0), endSec: z.number().min(0) }).optional(),
  /** Generated/supplied footage shot (T7, P6). Accepted media fills the scene's media layer. */
  shot: z
    .object({
      kind: z.enum(["image", "video"]).default("video"),
      prompt: z.string().max(1500),
      continuity: z.string().max(500).default(""),
      characterIds: z.array(Id).max(6).default([]),
      referenceAssetIds: z.array(Id).max(6).default([]),
      source: z.enum(["generate", "supplied"]).default("generate"),
      status: z.enum(["pending", "generating", "ready", "accepted", "failed"]).default("pending"),
      candidates: z.array(z.object({ assetId: Id, generationId: z.string().max(64).optional(), provider: z.string().max(40), createdAt: z.string().max(40), review: ShotReview.optional() })).max(12).default([]),
      acceptedAssetId: Id.optional(),
      /** Keyframe for a video shot (animatic first): a still of the intended first frame. */
      keyframeAssetId: Id.optional(),
      /** True when the pipeline accepted the first result automatically; the owner should review it. */
      autoAccepted: z.boolean().default(false),
      variant: z.number().int().min(1).default(1),
      error: z.string().max(300).optional(),
    })
    .optional(),
  /**
   * Event sizzle (P3): the authentic source moment this scene plays. Text is the verbatim
   * transcript of the kept segments; nothing here is ever generated (FR-16, A19).
   */
  quote: z
    .object({
      collectionId: Id.optional(),
      assetId: Id,
      transcriptId: Id,
      sourceName: z.string().max(200).default(""),
      /** Transcript segment ids fully inside the kept range. */
      segmentIds: z.array(z.string().max(40)).min(1).max(40),
      /** Spoken range (first word start .. last word end) in source seconds. */
      speechInSec: z.number().min(0),
      speechOutSec: z.number().min(0),
      /** Clip range including the clean handles cut in silence. */
      clipInSec: z.number().min(0),
      clipOutSec: z.number().min(0),
      text: z.string().max(1200),
      theme: z.string().max(40).default(""),
      speaker: z.string().max(80).default(""),
      /** Measured level at the cut points (dBFS RMS over 40 ms); null when not measured. */
      cutLevelsDb: z.object({ in: z.number().nullable(), out: z.number().nullable() }).default({ in: null, out: null }),
    })
    .optional(),
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
  /** Placed sound effect: its role in the sound kit and the moment it marks. */
  sfx: z.object({ role: z.string().max(20), event: z.string().max(120) }).optional(),
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

/**
 * Persistent character reference (T2): identity, palette, proportions and chosen poses.
 * Vector characters are drawn procedurally from these values; image characters use the
 * owner's cutouts. Generated identity is never assumed — references are what we reuse.
 */
export const Character = z.object({
  id: Id,
  name: z.string().max(60),
  mode: z.enum(["vector", "image"]).default("vector"),
  /** Owner-supplied reference images (and per-pose cutouts). */
  referenceAssetIds: z.array(Id).max(12).default([]),
  poseAssets: z.record(z.string().max(20), Id).default({}),
  palette: z.object({ body: HexColor, belly: HexColor, accent: HexColor, eye: HexColor }),
  proportions: z.object({ head: z.number().min(0.6).max(1.6).default(1), body: z.number().min(0.6).max(1.6).default(1), ears: z.number().min(0).max(2).default(1) }).default({ head: 1, body: 1, ears: 1 }),
  species: z.enum(["blob", "cat", "bear", "bird", "robot"]).default("blob"),
  /** Locked references can't be changed by the assistant or scene regeneration. */
  locked: z.boolean().default(true),
  notes: z.string().max(400).default(""),
});
export type Character = z.infer<typeof Character>;

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
  /** Visual accents on music markers: shapes hit on the chosen marker kind, sections flash. */
  musicAccents: z
    .object({ enabled: z.boolean().default(false), on: z.enum(["downbeat", "beat", "section"]).default("downbeat"), sectionFlash: z.boolean().default(true), strength: Unit.default(0.6) })
    .default({ enabled: false, on: "downbeat", sectionFlash: true, strength: 0.6 }),
  program: Program.optional(),
  /** Script stage: narration and on-screen lines per beat, approved before planning. */
  script: Script.optional(),
  /**
   * Animatic gate (Phase 4): once shots have keyframes, paid video generation waits until the
   * owner approves the animatic (keyframes timed to the voiceover and music).
   */
  animatic: z.object({ status: z.enum(["pending", "approved"]) }).optional(),
  /**
   * Shot-plan review: set when Claude plans a storyboard from the composer. Approval is the
   * owner's go-ahead for paid or slow steps that follow (voiceover, draft render).
   */
  review: z
    .object({
      status: z.enum(["pending", "approved"]),
      next: z.object({ voiceId: z.string().max(120).optional() }).default({}),
    })
    .optional(),
  beats: z.array(EditorialBeat).max(200).default([]),
  characters: z.array(Character).max(6).default([]),
  /**
   * Asset acquisition policy (FR-15), chosen by the owner: only existing uploads/brand assets,
   * also public references (URL import, website screenshots), or generated media within budget.
   */
  acquisitionPolicy: z.enum(["existing-only", "existing-plus-public", "generated-allowed"]).default("existing-plus-public"),
  /** Owner opt-in: run Claude's product check on every new generated take that has a reference photo. */
  autoProductCheck: z.boolean().default(false),
  /** Made to loop (social feeds replay it): the last frame should match the first. */
  loop: z.boolean().default(false),
  /** Seed for any procedural variation; part of the render bundle hash. */
  seed: z.number().int().default(1),
});
export type ProjectDocument = z.infer<typeof ProjectDocument>;
export type ProjectDocumentInput = z.input<typeof ProjectDocument>;

export function parseDocument(input: unknown): ProjectDocument {
  return ProjectDocument.parse(input);
}

/** Collect every asset id a document references. */
export function referencedAssetIds(doc: ProjectDocument): string[] {
  const ids = new Set<string>();
  for (const s of doc.scenes) {
    if (s.background.type === "asset") ids.add(s.background.assetId);
    for (const l of s.layers) if ((l.kind === "image" || l.kind === "video") && l.assetId) ids.add(l.assetId);
  }
  for (const t of doc.audio) ids.add(t.assetId);
  if (doc.brand.logoAssetId) ids.add(doc.brand.logoAssetId);
  for (const f of [doc.brand.fonts.heading, doc.brand.fonts.body]) if (f.assetId) ids.add(f.assetId);
  if (doc.program) ids.add(doc.program.sourceAssetId);
  for (const s of doc.scenes) if (s.shot?.keyframeAssetId) ids.add(s.shot.keyframeAssetId);
  for (const b of doc.beats) if (b.assetId) ids.add(b.assetId);
  for (const c of doc.characters) {
    if (c.mode !== "image") continue;
    for (const r of c.referenceAssetIds) ids.add(r);
    for (const r of Object.values(c.poseAssets)) ids.add(r);
  }
  // Graphics parameters that hold asset ids (e.g. a product image for a Skia reveal).
  for (const s of doc.scenes) for (const l of s.layers) if (l.kind === "graphics") for (const v of Object.values(l.params)) if (typeof v === "string" && /^ast_[a-z0-9]{8,}$/.test(v)) ids.add(v);
  return [...ids];
}

