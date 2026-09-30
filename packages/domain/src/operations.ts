import { z } from "zod";
import {
  AudioTrack,
  ColorRef,
  Background,
  BrandSnapshot,
  CaptionCue,
  Captions,
  CreativeProfileSnapshot,
  EditorialBeat,
  Character,
  CharacterLayer,
  type EdlEntry,
  Id,
  Layer,
  LayerBox,
  MusicMarker,
  Program,
  ProjectDocument,
  Scene,
  ShotReview,
  TextLayer,
  Transition,
} from "./document";
import { AspectRatio, SafeAreaPresetIdSchema } from "./format";
import { computeTimeline, validateTimeline } from "./timeline";
import { varyScene } from "./variation";
import { syncProgramScenes } from "./program";
import { Script, ScriptBeat } from "./script";
import { VoiceDirection } from "./voice";

const Unit = z.number().min(0).max(1);

/** Typed edit operations. Every write goes through these; nothing patches JSON directly. */
export const Operation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("setTitle"), title: z.string().min(1).max(160) }),
  z.object({ op: z.literal("updateLayerText"), sceneId: Id, layerId: Id, text: z.string().max(600) }),
  z.object({ op: z.literal("setLayerStyle"), sceneId: Id, layerId: Id, style: TextLayer.shape.style.unwrap().partial() }),
  z.object({
    op: z.literal("setLayerAnimation"),
    sceneId: Id,
    layerId: Id,
    animation: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  }),
  z.object({ op: z.literal("replaceSceneAsset"), sceneId: Id, layerId: Id, assetId: Id.nullable() }),
  z.object({
    op: z.literal("setLayerMedia"),
    sceneId: Id,
    layerId: Id,
    fit: z.enum(["cover", "contain"]).optional(),
    focal: z.object({ x: Unit, y: Unit }).optional(),
    frame: z.enum(["none", "card", "laptop", "phone", "circle", "rounded"]).optional(),
    sourceInSec: z.number().min(0).optional(),
    sourceOutSec: z.number().positive().nullable().optional(),
    muted: z.boolean().optional(),
  }),
  z.object({ op: z.literal("setLayerBox"), sceneId: Id, layerId: Id, box: LayerBox.nullable() }),
  z.object({ op: z.literal("setLayerHidden"), sceneId: Id, layerId: Id, hidden: z.boolean() }),
  z.object({ op: z.literal("setShapeColor"), sceneId: Id, layerId: Id, color: ColorRef }),
  z.object({ op: z.literal("setGraphicsParams"), sceneId: Id, layerId: Id, params: z.record(z.string(), z.union([z.number(), z.string().max(400), z.boolean()])) }),
  z.object({ op: z.literal("addLayer"), sceneId: Id, layer: Layer }),
  z.object({ op: z.literal("removeLayer"), sceneId: Id, layerId: Id }),
  z.object({ op: z.literal("setSceneDuration"), sceneId: Id, durationFrames: z.number().int().positive() }),
  z.object({ op: z.literal("setSceneTransition"), sceneId: Id, transition: Transition }),
  z.object({ op: z.literal("setSceneBackground"), sceneId: Id, background: Background }),
  z.object({ op: z.literal("setSceneLayout"), sceneId: Id, layout: z.string().max(40) }),
  z.object({ op: z.literal("setSceneMotion"), sceneId: Id, motionIntensity: Unit }),
  z.object({ op: z.literal("setSceneScript"), sceneId: Id, narration: z.string().max(1200) }),
  z.object({ op: z.literal("setSceneMeta"), sceneId: Id, purpose: z.string().max(80).optional(), notes: z.string().max(1000).optional() }),
  z.object({ op: z.literal("setSceneLock"), sceneId: Id, locked: z.boolean() }),
  z.object({ op: z.literal("moveScene"), sceneId: Id, toIndex: z.number().int().min(0) }),
  z.object({ op: z.literal("addScene"), scene: Scene, index: z.number().int().min(0).optional() }),
  z.object({ op: z.literal("duplicateScene"), sceneId: Id, newSceneId: Id }),
  z.object({ op: z.literal("deleteScene"), sceneId: Id }),
  z.object({ op: z.literal("replaceScenes"), scenes: z.array(Scene).min(1).max(60) }),
  z.object({ op: z.literal("setFormat"), aspect: AspectRatio.optional(), safeArea: SafeAreaPresetIdSchema.optional() }),
  z.object({ op: z.literal("applyBrand"), brand: BrandSnapshot }),
  z.object({ op: z.literal("applyCreativeProfile"), profile: CreativeProfileSnapshot }),
  z.object({ op: z.literal("updateBrief"), brief: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal("addAudioTrack"), track: AudioTrack }),
  z.object({ op: z.literal("updateAudioTrack"), trackId: Id, patch: AudioTrack.omit({ id: true }).partial() }),
  z.object({ op: z.literal("setTrackGain"), trackId: Id, gainDb: z.number().min(-60).max(12) }),
  z.object({ op: z.literal("removeAudioTrack"), trackId: Id }),
  z.object({ op: z.literal("setCaptions"), captions: Captions.partial() }),
  z.object({ op: z.literal("setCaptionCues"), cues: z.array(CaptionCue).max(2000) }),
  z.object({ op: z.literal("updateCaptionCue"), cueId: Id, text: z.string().max(300).optional(), startFrame: z.number().int().min(0).optional(), endFrame: z.number().int().positive().optional() }),
  z.object({ op: z.literal("setMarkers"), markers: z.array(MusicMarker).max(1000) }),
  z.object({ op: z.literal("updateShot"), sceneId: Id, patch: z.object({ prompt: z.string().max(1500), continuity: z.string().max(500), referenceAssetIds: z.array(Id).max(6), characterIds: z.array(Id).max(6), kind: z.enum(["image", "video"]) }).partial() }),
  z.object({ op: z.literal("setShotStatus"), sceneId: Id, status: z.enum(["pending", "generating", "ready", "accepted", "failed"]), error: z.string().max(300).optional(), variant: z.number().int().min(1).optional() }),
  z.object({ op: z.literal("addShotCandidate"), sceneId: Id, candidate: z.object({ assetId: Id, generationId: z.string().max(64).optional(), provider: z.string().max(40), createdAt: z.string().max(40), review: ShotReview.optional() }), autoAccept: z.boolean().default(false) }),
  z.object({ op: z.literal("reviewShotCandidate"), sceneId: Id, assetId: Id, decision: z.enum(["approved", "rejected"]) }),
  z.object({ op: z.literal("acceptShot"), sceneId: Id, assetId: Id, supplied: z.boolean().default(false) }),
  z.object({ op: z.literal("varyScene"), sceneId: Id, variant: z.number().int().min(1).max(1_000_000) }),
  z.object({ op: z.literal("setCharacters"), characters: z.array(Character).max(6) }),
  z.object({ op: z.literal("updateCharacter"), characterId: Id, patch: Character.omit({ id: true }).partial() }),
  z.object({ op: z.literal("setCharacterPose"), sceneId: Id, layerId: Id, pose: CharacterLayer.shape.pose.unwrap().optional(), accessory: CharacterLayer.shape.accessory.unwrap().optional(), facing: CharacterLayer.shape.facing.unwrap().optional(), scale: z.number().min(0.2).max(3).optional() }),
  z.object({ op: z.literal("setMusicAccents"), accents: z.object({ enabled: z.boolean(), on: z.enum(["downbeat", "beat", "section"]), sectionFlash: z.boolean(), strength: z.number().min(0).max(1) }).partial() }),
  z.object({ op: z.literal("addMarker"), marker: MusicMarker }),
  z.object({ op: z.literal("moveMarker"), markerId: Id, frame: z.number().int().min(0) }),
  z.object({ op: z.literal("removeMarker"), markerId: Id }),
  z.object({ op: z.literal("verifyMarkers"), markerIds: z.array(Id).max(1000) }),
  z.object({ op: z.literal("fitScenesToMarkers"), kinds: z.array(z.enum(["section", "downbeat", "beat"])).min(1) }),
  z.object({ op: z.literal("setMusicLock"), enabled: z.boolean(), trackId: Id.optional() }),
  z.object({ op: z.literal("setProgram"), program: Program }),
  z.object({ op: z.literal("setScript"), script: Script.nullable() }),
  z.object({ op: z.literal("updateScriptBeat"), beatId: z.string().max(64), patch: z.object({ narration: z.string().max(1200), onScreen: z.string().max(220), durationSec: ScriptBeat.shape.durationSec, purpose: z.string().max(80), direction: VoiceDirection.nullable() }).partial() }),
  z.object({ op: z.literal("setSceneVoiceDirection"), sceneId: Id, direction: VoiceDirection.nullable() }),
  z.object({ op: z.literal("setScriptStatus"), status: z.enum(["draft", "approved"]) }),
  z.object({ op: z.literal("setReviewStatus"), status: z.enum(["pending", "approved"]) }),
  z.object({ op: z.literal("setShotKeyframe"), sceneId: Id, assetId: Id.nullable() }),
  z.object({ op: z.literal("setAnimaticStatus"), status: z.enum(["pending", "approved"]) }),
  z.object({ op: z.literal("proposeCuts"), cuts: Program.shape.proposedCuts.unwrap() }),
  z.object({ op: z.literal("acceptCuts"), cutIds: z.array(Id).min(1) }),
  z.object({ op: z.literal("rejectCuts"), cutIds: z.array(Id).min(1) }),
  z.object({ op: z.literal("restoreSourceRange"), sourceInSec: z.number().min(0), sourceOutSec: z.number().positive() }),
  z.object({ op: z.literal("correctTranscript"), segmentId: z.string().max(40), text: z.string().max(2000) }),
  z.object({ op: z.literal("setCleanupPolicy"), autoAcceptSilence: z.boolean(), autoAcceptFillers: z.boolean() }),
  z.object({ op: z.literal("setCreativeMode"), mode: z.enum(["strict", "flexible"]), flexibleBeatLimit: z.number().int().min(0).max(20).optional() }),
  z.object({ op: z.literal("setPresenterFraming"), framing: Program.shape.presenterFraming.unwrap() }),
  z.object({ op: z.literal("setBeats"), beats: z.array(EditorialBeat).max(200) }),
  z.object({ op: z.literal("updateBeat"), beatId: Id, patch: EditorialBeat.omit({ id: true }).partial() }),
  z.object({ op: z.literal("setBeatAnchor"), beatId: Id, anchor: z.object({ x: Unit, y: Unit }).nullable(), lock: z.boolean().default(true) }),
  z.object({ op: z.literal("mapBeatToTranscriptOccurrence"), beatId: Id, occurrence: z.number().int().min(1), sourceStartSec: z.number().min(0), sourceEndSec: z.number().min(0) }),
  z.object({ op: z.literal("setSeed"), seed: z.number().int() }),
  z.object({ op: z.literal("setAcquisitionPolicy"), policy: z.enum(["existing-only", "existing-plus-public", "generated-allowed"]) }),
]);
export type Operation = z.infer<typeof Operation>;

export type Actor = "user" | "assistant" | "bulk" | "system";

export class OperationError extends Error {
  constructor(
    public code: "not_found" | "locked" | "approved_claim" | "invalid" | "timeline" | "conflict" | "strict_mode" | "flexible_limit" | "flexible_asset",
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface ApplyResult {
  doc: ProjectDocument;
  /** Scene ids whose content changed (not merely their absolute position). */
  changedSceneIds: string[];
}

const SCENE_CONTENT_OPS = new Set<Operation["op"]>([
  "updateLayerText",
  "setLayerStyle",
  "setLayerAnimation",
  "replaceSceneAsset",
  "setLayerMedia",
  "setLayerBox",
  "setLayerHidden",
  "setGraphicsParams",
  "setShapeColor",
  "addLayer",
  "removeLayer",
  "setSceneDuration",
  "setSceneTransition",
  "setSceneBackground",
  "setSceneLayout",
  "setSceneMotion",
  "setSceneScript",
  "setSceneVoiceDirection",
  "setSceneMeta",
  "deleteScene",
]);

/**
 * Apply operations atomically. Rules:
 * - Locked scenes: content cannot change for any actor until unlocked (ripple of absolute position is allowed).
 * - Approved claims: assistant/bulk cannot rewrite text bound to an approved fact.
 * - The result must re-validate and must not introduce new timeline errors.
 */
export function applyOperations(input: ProjectDocument, ops: Operation[], actor: Actor): ApplyResult {
  let doc: ProjectDocument = structuredClone(input);
  const changed = new Set<string>();
  const before = new Set(validateTimeline(input).filter((i) => i.severity === "error").map((i) => `${i.code}:${i.sceneId ?? ""}:${i.layerId ?? ""}`));

  for (const op of ops) {
    doc = applyOne(doc, op, actor, changed);
  }

  const parsed = ProjectDocument.safeParse(doc);
  if (!parsed.success) {
    throw new OperationError("invalid", "The edit produced an invalid project document.", parsed.error.issues.slice(0, 5));
  }
  if (actor === "assistant") checkCreativeMode(input, parsed.data);
  const introduced = validateTimeline(parsed.data).filter(
    (i) => i.severity === "error" && !before.has(`${i.code}:${i.sceneId ?? ""}:${i.layerId ?? ""}`),
  );
  if (introduced.length > 0) {
    throw new OperationError("timeline", introduced.map((i) => i.message).join(" "), introduced);
  }
  return { doc: parsed.data, changedSceneIds: [...changed] };
}

function findScene(doc: ProjectDocument, sceneId: string): Scene {
  const s = doc.scenes.find((x) => x.id === sceneId);
  if (!s) throw new OperationError("not_found", `Scene ${sceneId} does not exist.`);
  return s;
}

function findLayer(scene: Scene, layerId: string): Layer {
  const l = scene.layers.find((x) => x.id === layerId);
  if (!l) throw new OperationError("not_found", `Layer ${layerId} does not exist in scene "${scene.purpose}".`);
  return l;
}

function guardScene(scene: Scene, op: Operation, actor: Actor) {
  if (scene.locked && SCENE_CONTENT_OPS.has(op.op)) {
    throw new OperationError(
      "locked",
      actor === "user"
        ? `Scene "${scene.purpose}" is locked. Unlock it before editing its content.`
        : `Scene "${scene.purpose}" is locked; ${actor} edits cannot modify it.`,
    );
  }
}

function applyOne(doc: ProjectDocument, op: Operation, actor: Actor, changed: Set<string>): ProjectDocument {
  const sceneOp = "sceneId" in op ? findScene(doc, op.sceneId) : undefined;
  if (sceneOp) guardScene(sceneOp, op, actor);

  switch (op.op) {
    case "setTitle":
      doc.title = op.title;
      return doc;
    case "updateLayerText": {
      const layer = findLayer(sceneOp!, op.layerId);
      if (layer.kind !== "text") throw new OperationError("invalid", "Only text layers have text.");
      if (layer.approvedFactId && actor !== "user" && layer.text !== op.text) {
        throw new OperationError("approved_claim", `"${layer.text}" is an approved claim; only the owner can change it.`);
      }
      layer.text = op.text;
      changed.add(sceneOp!.id);
      return doc;
    }
    case "setLayerStyle": {
      const layer = findLayer(sceneOp!, op.layerId);
      if (layer.kind !== "text") throw new OperationError("invalid", "Style applies to text layers.");
      layer.style = { ...layer.style, ...stripUndefined(op.style) };
      changed.add(sceneOp!.id);
      return doc;
    }
    case "setLayerAnimation": {
      const layer = findLayer(sceneOp!, op.layerId) as Layer & { animation?: Record<string, unknown> };
      if (layer.kind === "graphics") throw new OperationError("invalid", "Graphics layers animate through their parameters.");
      layer.animation = { ...(layer.animation ?? {}), ...op.animation };
      changed.add(sceneOp!.id);
      return doc;
    }
    case "replaceSceneAsset": {
      const layer = findLayer(sceneOp!, op.layerId);
      if (layer.kind !== "image" && layer.kind !== "video") throw new OperationError("invalid", "Only image and video layers hold assets.");
      layer.assetId = op.assetId;
      changed.add(sceneOp!.id);
      return doc;
    }
    case "setLayerMedia": {
      const layer = findLayer(sceneOp!, op.layerId);
      if (layer.kind !== "image" && layer.kind !== "video") throw new OperationError("invalid", "Only image and video layers have media settings.");
      if (op.fit) layer.fit = op.fit;
      if (op.focal) layer.focal = op.focal;
      if (op.frame) layer.frame = op.frame;
      if (layer.kind === "video") {
        if (op.sourceInSec !== undefined) layer.sourceInSec = op.sourceInSec;
        if (op.sourceOutSec !== undefined) layer.sourceOutSec = op.sourceOutSec;
        if (op.muted !== undefined) layer.muted = op.muted;
      }
      changed.add(sceneOp!.id);
      return doc;
    }
    case "setLayerBox": {
      const layer = findLayer(sceneOp!, op.layerId);
      if (op.box) layer.box = op.box;
      else delete layer.box;
      changed.add(sceneOp!.id);
      return doc;
    }
    case "setLayerHidden": {
      findLayer(sceneOp!, op.layerId).hidden = op.hidden;
      changed.add(sceneOp!.id);
      return doc;
    }
    case "setGraphicsParams": {
      const layer = findLayer(sceneOp!, op.layerId);
      if (layer.kind !== "graphics") throw new OperationError("invalid", "Not a graphics layer.");
      layer.params = { ...layer.params, ...op.params };
      changed.add(sceneOp!.id);
      return doc;
    }
    case "setShapeColor": {
      const layer = findLayer(sceneOp!, op.layerId);
      if (layer.kind !== "shape") throw new OperationError("invalid", "Not a shape layer.");
      layer.color = op.color;
      changed.add(sceneOp!.id);
      return doc;
    }
    case "addLayer": {
      if (sceneOp!.layers.some((l) => l.id === op.layer.id)) throw new OperationError("invalid", `Layer ${op.layer.id} already exists.`);
      sceneOp!.layers.push(op.layer);
      changed.add(sceneOp!.id);
      return doc;
    }
    case "removeLayer": {
      const layer = findLayer(sceneOp!, op.layerId);
      if (layer.kind === "text" && layer.approvedFactId && actor !== "user") {
        throw new OperationError("approved_claim", "Approved claims cannot be removed by the assistant.");
      }
      sceneOp!.layers = sceneOp!.layers.filter((l) => l.id !== op.layerId);
      changed.add(sceneOp!.id);
      return doc;
    }
    case "setSceneDuration":
      sceneOp!.durationFrames = op.durationFrames;
      changed.add(sceneOp!.id);
      return doc;
    case "setSceneTransition":
      sceneOp!.transitionIn = op.transition.type === "cut" ? { type: "cut", durationFrames: 0 } : op.transition;
      changed.add(sceneOp!.id);
      return doc;
    case "setSceneBackground":
      sceneOp!.background = op.background;
      changed.add(sceneOp!.id);
      return doc;
    case "setSceneLayout":
      sceneOp!.layout = op.layout;
      changed.add(sceneOp!.id);
      return doc;
    case "setSceneMotion":
      sceneOp!.motionIntensity = op.motionIntensity;
      changed.add(sceneOp!.id);
      return doc;
    case "setSceneVoiceDirection":
      if (op.direction) sceneOp!.script.direction = op.direction;
      else delete sceneOp!.script.direction;
      changed.add(sceneOp!.id);
      return doc;
    case "setSceneScript":
      sceneOp!.script = { ...sceneOp!.script, narration: op.narration };
      changed.add(sceneOp!.id);
      return doc;
    case "setSceneMeta":
      if (op.purpose !== undefined) sceneOp!.purpose = op.purpose;
      if (op.notes !== undefined) sceneOp!.notes = op.notes;
      changed.add(sceneOp!.id);
      return doc;
    case "setSceneLock":
      if (actor === "assistant" && !op.locked) throw new OperationError("locked", "The assistant cannot unlock scenes.");
      sceneOp!.locked = op.locked;
      return doc;
    case "moveScene": {
      const from = doc.scenes.findIndex((s) => s.id === op.sceneId);
      const [s] = doc.scenes.splice(from, 1);
      doc.scenes.splice(Math.min(op.toIndex, doc.scenes.length), 0, s!);
      // A scene moved to the front cannot overlap anything.
      doc.scenes[0]!.transitionIn = doc.scenes[0]!.transitionIn.type === "cut" ? doc.scenes[0]!.transitionIn : { type: "cut", durationFrames: 0 };
      return doc;
    }
    case "addScene": {
      if (doc.scenes.some((s) => s.id === op.scene.id)) throw new OperationError("invalid", `Scene ${op.scene.id} already exists.`);
      doc.scenes.splice(op.index ?? doc.scenes.length, 0, op.scene);
      changed.add(op.scene.id);
      return doc;
    }
    case "duplicateScene": {
      if (doc.scenes.some((s) => s.id === op.newSceneId)) throw new OperationError("invalid", `Scene ${op.newSceneId} already exists.`);
      const idx = doc.scenes.findIndex((s) => s.id === op.sceneId);
      const copy = structuredClone(sceneOp!);
      copy.id = op.newSceneId;
      copy.locked = false;
      copy.layers = copy.layers.map((l, i) => ({ ...l, id: `${op.newSceneId}-l${i}` }));
      doc.scenes.splice(idx + 1, 0, copy);
      changed.add(copy.id);
      return doc;
    }
    case "deleteScene": {
      if (doc.scenes.length <= 1) throw new OperationError("invalid", "A project needs at least one scene.");
      doc.scenes = doc.scenes.filter((s) => s.id !== op.sceneId);
      // Remove narration anchored to the deleted scene; other audio keeps its anchor.
      doc.audio = doc.audio.filter((t) => !(t.kind === "voiceover" && t.anchor.type === "scene" && t.anchor.sceneId === op.sceneId));
      doc.captions.cues = doc.captions.cues.filter((c) => !(c.anchor.type === "scene" && c.anchor.sceneId === op.sceneId));
      if (doc.scenes[0]) doc.scenes[0].transitionIn = { type: "cut", durationFrames: 0 };
      changed.add(op.sceneId);
      return doc;
    }
    case "replaceScenes": {
      // Planner/bulk output. Locked scenes are preserved exactly, in their existing positions.
      const locked = new Map(doc.scenes.filter((s) => s.locked).map((s) => [s.id, s]));
      const next = op.scenes.map((s) => locked.get(s.id) ?? s);
      for (const [id, s] of locked) if (!next.some((n) => n.id === id)) next.splice(Math.min(doc.scenes.findIndex((x) => x.id === id), next.length), 0, s);
      for (const s of next) if (!locked.has(s.id)) changed.add(s.id);
      doc.scenes = next;
      return doc;
    }
    case "setFormat":
      if (op.aspect) doc.format.aspect = op.aspect;
      if (op.safeArea) doc.format.safeArea = op.safeArea;
      return doc;
    case "applyBrand":
      doc.brand = op.brand;
      return doc;
    case "applyCreativeProfile":
      doc.profile = op.profile;
      // Transitions follow the profile on unlocked scenes that already have one (cuts stay cuts
      // unless the profile asks for cuts everywhere). Locked scenes are never touched.
      doc.scenes.forEach((s, i) => {
        if (i === 0 || s.locked || s.transitionIn.type === "cut") return;
        s.transitionIn = op.profile.transition === "cut" ? { type: "cut", durationFrames: 0 } : { type: op.profile.transition, durationFrames: s.transitionIn.durationFrames };
      });
      return doc;
    case "updateBrief": {
      const merged = { ...doc.brief, ...op.brief };
      if (actor !== "user") {
        // Approved facts are owner-controlled.
        (merged as Record<string, unknown>).approvedFacts = doc.brief.approvedFacts;
      }
      doc.brief = merged as ProjectDocument["brief"];
      return doc;
    }
    case "addAudioTrack":
      if (doc.audio.some((t) => t.id === op.track.id)) throw new OperationError("invalid", `Track ${op.track.id} already exists.`);
      doc.audio.push(op.track);
      return doc;
    case "updateAudioTrack": {
      const t = findTrack(doc, op.trackId);
      if (actor === "assistant" && t.kind === "source" && op.patch.gainDb !== undefined && op.patch.gainDb <= -60) {
        throw new OperationError("invalid", "The assistant cannot remove source speech.");
      }
      Object.assign(t, stripUndefined(op.patch));
      return doc;
    }
    case "setTrackGain":
      findTrack(doc, op.trackId).gainDb = op.gainDb;
      return doc;
    case "removeAudioTrack": {
      const t = findTrack(doc, op.trackId);
      if (t.kind === "source" && actor !== "user") throw new OperationError("invalid", "Source speech can only be removed by the owner.");
      doc.audio = doc.audio.filter((x) => x.id !== op.trackId);
      return doc;
    }
    case "setCaptions":
      doc.captions = { ...doc.captions, ...stripUndefined(op.captions) } as ProjectDocument["captions"];
      return doc;
    case "setCaptionCues":
      doc.captions.cues = op.cues;
      return doc;
    case "updateCaptionCue": {
      const c = doc.captions.cues.find((x) => x.id === op.cueId);
      if (!c) throw new OperationError("not_found", `Caption ${op.cueId} does not exist.`);
      if (op.text !== undefined) {
        c.text = op.text;
        c.timing = c.timing === "word" ? "segment" : c.timing; // edited words no longer have measured word timing
        delete c.words;
      }
      if (op.startFrame !== undefined) c.startFrame = op.startFrame;
      if (op.endFrame !== undefined) c.endFrame = op.endFrame;
      if (c.endFrame <= c.startFrame) throw new OperationError("invalid", "Caption must end after it starts.");
      return doc;
    }
    case "setMarkers":
      doc.markers = op.markers;
      return doc;
    case "updateShot": {
      const s = findScene(doc, op.sceneId);
      if (!s.shot) throw new OperationError("invalid", "This scene is not a footage shot.");
      if (s.locked && actor !== "user") throw new OperationError("locked", `Scene “${s.purpose}” is locked.`);
      Object.assign(s.shot, stripUndefined(op.patch));
      changed.add(s.id);
      return doc;
    }
    case "setShotStatus": {
      const s = findScene(doc, op.sceneId);
      if (!s.shot) throw new OperationError("invalid", "This scene is not a footage shot.");
      // An accepted shot is never downgraded by pipeline status updates (A13).
      if (s.shot.status === "accepted" && actor !== "user") return doc;
      s.shot.status = op.status;
      s.shot.error = op.error;
      if (op.variant) s.shot.variant = op.variant;
      changed.add(s.id);
      return doc;
    }
    case "addShotCandidate": {
      const s = findScene(doc, op.sceneId);
      if (!s.shot) throw new OperationError("invalid", "This scene is not a footage shot.");
      if (!s.shot.candidates.some((c) => c.assetId === op.candidate.assetId)) s.shot.candidates = [...s.shot.candidates, op.candidate].slice(-12);
      // A candidate flagged by the fidelity check is never auto-accepted: it waits for review.
      if (op.autoAccept && !s.shot.acceptedAssetId && !op.candidate.review?.flagged) {
        acceptShotMedia(s, op.candidate.assetId);
        s.shot.autoAccepted = true;
      } else if (s.shot.status !== "accepted") s.shot.status = "ready";
      s.shot.error = undefined;
      changed.add(s.id);
      return doc;
    }
    case "setAcquisitionPolicy":
      if (actor !== "user") throw new OperationError("invalid", "Only the owner changes what may be sourced or generated.");
      doc.acquisitionPolicy = op.policy;
      return doc;
    case "reviewShotCandidate": {
      if (actor !== "user") throw new OperationError("invalid", "Only the owner reviews generated shots.");
      const s = findScene(doc, op.sceneId);
      const c = s.shot?.candidates.find((x) => x.assetId === op.assetId);
      if (!s.shot || !c) throw new OperationError("invalid", "That asset is not a candidate for this shot.");
      c.review = { ...(c.review ?? { paletteSimilarity: null, flagged: false, method: "owner review" }), decision: op.decision };
      // Rejecting the accepted candidate takes it off the timeline; the shot goes back to pending.
      if (op.decision === "rejected" && s.shot.acceptedAssetId === op.assetId) {
        s.shot.acceptedAssetId = undefined;
        s.shot.status = "pending";
        s.shot.autoAccepted = false;
        for (const l of s.layers) if ((l.kind === "video" || l.kind === "image") && l.slot === "media" && l.assetId === op.assetId) l.assetId = null;
      }
      changed.add(s.id);
      return doc;
    }
    case "acceptShot": {
      const s = findScene(doc, op.sceneId);
      if (!s.shot) throw new OperationError("invalid", "This scene is not a footage shot.");
      if (s.locked && actor !== "user") throw new OperationError("locked", `Scene “${s.purpose}” is locked.`);
      if (!op.supplied && !s.shot.candidates.some((c) => c.assetId === op.assetId)) throw new OperationError("invalid", "That asset is not a candidate for this shot.");
      if (!op.supplied && actor !== "user" && s.shot.candidates.find((c) => c.assetId === op.assetId)?.review?.flagged) throw new OperationError("invalid", "This candidate was flagged for product fidelity; only the owner can accept it.");
      if (op.supplied) s.shot.source = "supplied";
      acceptShotMedia(s, op.assetId);
      s.shot.autoAccepted = false;
      changed.add(s.id);
      return doc;
    }
    case "varyScene": {
      const s = findScene(doc, op.sceneId);
      if (s.locked) throw new OperationError("locked", `Scene “${s.purpose}” is locked.`);
      const v = varyScene(doc, op.sceneId, op.variant);
      doc.scenes = doc.scenes.map((x) => (x.id === s.id ? v : x));
      changed.add(s.id);
      return doc;
    }
    case "setCharacters": {
      for (const c of doc.characters.filter((x) => x.locked)) {
        const n = op.characters.find((x) => x.id === c.id);
        if (actor !== "user" && (!n || JSON.stringify(n) !== JSON.stringify(c))) throw new OperationError("locked", `Character “${c.name}” is locked.`);
      }
      doc.characters = op.characters;
      return doc;
    }
    case "updateCharacter": {
      const c = doc.characters.find((x) => x.id === op.characterId);
      if (!c) throw new OperationError("not_found", "Character not found.");
      const unlocking = op.patch.locked === false;
      if (c.locked && (actor !== "user" || (!unlocking && Object.keys(op.patch).some((k) => k !== "locked" && k !== "notes")))) {
        throw new OperationError("locked", `Character “${c.name}” is locked; unlock its references before changing them.`);
      }
      Object.assign(c, stripUndefined(op.patch));
      for (const s of doc.scenes) if (s.layers.some((l) => l.kind === "character" && l.characterId === c.id)) changed.add(s.id);
      return doc;
    }
    case "setCharacterPose": {
      const s = findScene(doc, op.sceneId);
      const l = findLayer(s, op.layerId);
      if (l.kind !== "character") throw new OperationError("invalid", "That layer is not a character.");
      if (s.locked && actor !== "user") throw new OperationError("locked", "This scene is locked.");
      Object.assign(l, stripUndefined({ pose: op.pose, accessory: op.accessory, facing: op.facing, scale: op.scale }));
      changed.add(s.id);
      return doc;
    }
    case "setMusicAccents":
      doc.musicAccents = { ...doc.musicAccents, ...stripUndefined(op.accents) };
      return doc;
    case "addMarker":
      doc.markers = [...doc.markers.filter((m) => m.id !== op.marker.id), { ...op.marker, verified: actor === "user" ? true : op.marker.verified }].sort((a, b) => a.frame - b.frame);
      return doc;
    case "moveMarker": {
      const m = doc.markers.find((x) => x.id === op.markerId);
      if (!m) throw new OperationError("not_found", "Marker not found.");
      m.frame = op.frame;
      // Moving a marker is an owner decision: it becomes verified.
      if (actor === "user") m.verified = true;
      doc.markers.sort((a, b) => a.frame - b.frame);
      return doc;
    }
    case "removeMarker":
      doc.markers = doc.markers.filter((m) => m.id !== op.markerId);
      return doc;
    case "verifyMarkers":
      for (const m of doc.markers) if (op.markerIds.includes(m.id)) m.verified = true;
      return doc;
    case "fitScenesToMarkers": {
      const r = fitScenesToMarkers(doc, op.kinds);
      if (r.conflicts.length && r.fitted === 0) throw new OperationError("conflict", r.conflicts.join(" "));
      for (const s of doc.scenes) {
        const n = r.doc.scenes.find((x) => x.id === s.id)!;
        if (n.durationFrames !== s.durationFrames) changed.add(s.id);
      }
      return r.doc;
    }
    case "setMusicLock":
      doc.musicLock = { enabled: op.enabled, trackId: op.trackId };
      return doc;
    case "setProgram":
      doc.program = op.program;
      return syncProgramScenes(doc);
    case "setScript":
      if (op.script) doc.script = op.script;
      else delete doc.script;
      return doc;
    case "updateScriptBeat": {
      if (!doc.script) throw new OperationError("not_found", "This project has no script.");
      const beat = doc.script.beats.find((b) => b.id === op.beatId);
      if (!beat) throw new OperationError("not_found", `Script beat ${op.beatId} does not exist.`);
      const { direction, ...rest } = op.patch;
      Object.assign(beat, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
      if (direction === null) delete beat.direction;
      else if (direction) beat.direction = direction;
      // Editing an approved script reopens it: approval always covers the exact words.
      doc.script.status = "draft";
      return doc;
    }
    case "setShotKeyframe": {
      const s = findScene(doc, op.sceneId);
      if (!s.shot) throw new OperationError("invalid", "This scene is not a footage shot.");
      if (op.assetId) s.shot.keyframeAssetId = op.assetId;
      else delete s.shot.keyframeAssetId;
      // A new keyframe changes the animatic: approval must cover what is actually shown.
      doc.animatic = { status: "pending" };
      changed.add(s.id);
      return doc;
    }
    case "setAnimaticStatus":
      if (!doc.animatic) throw new OperationError("not_found", "This project has no animatic yet: generate keyframes first.");
      if (op.status === "approved" && actor !== "user") throw new OperationError("approved_claim", "Only the owner can approve the animatic.");
      if (op.status === "approved" && doc.scenes.some((s) => s.shot?.kind === "video" && s.shot.source === "generate" && !s.shot.acceptedAssetId && !s.shot.keyframeAssetId)) {
        throw new OperationError("invalid", "Every video shot needs a keyframe (or its own footage) before the animatic can be approved.");
      }
      doc.animatic.status = op.status;
      return doc;
    case "setReviewStatus":
      if (!doc.review) throw new OperationError("not_found", "This project has no shot plan to review.");
      if (op.status === "approved" && actor !== "user") throw new OperationError("approved_claim", "Only the owner can approve the shot plan.");
      doc.review.status = op.status;
      return doc;
    case "setScriptStatus":
      if (!doc.script) throw new OperationError("not_found", "This project has no script.");
      if (op.status === "approved" && actor !== "user") throw new OperationError("approved_claim", "Only the owner can approve the script.");
      doc.script.status = op.status;
      return doc;
    case "proposeCuts":
      requireProgram(doc).proposedCuts = op.cuts;
      return doc;
    case "acceptCuts": {
      const p = requireProgram(doc);
      const accepted = p.proposedCuts.filter((c) => op.cutIds.includes(c.id));
      p.edl = subtractRanges(p.edl, accepted);
      p.proposedCuts = p.proposedCuts.filter((c) => !op.cutIds.includes(c.id));
      return syncProgramScenes(doc);
    }
    case "restoreSourceRange": {
      const p = requireProgram(doc);
      p.edl = restoreRange(p.edl, op.sourceInSec, op.sourceOutSec, p.sourceAssetId);
      return syncProgramScenes(doc);
    }
    case "correctTranscript": {
      if (actor === "assistant") throw new OperationError("invalid", "Transcript corrections are made by the owner.");
      const p = requireProgram(doc);
      p.corrections = { ...p.corrections, [op.segmentId]: op.text.trim() };
      return doc;
    }
    case "setCleanupPolicy": {
      if (actor !== "user") throw new OperationError("invalid", "Only the owner can authorise a cleanup policy.");
      requireProgram(doc).cleanupPolicy = { autoAcceptSilence: op.autoAcceptSilence, autoAcceptFillers: op.autoAcceptFillers };
      return doc;
    }
    case "setCreativeMode": {
      if (actor !== "user") throw new OperationError("invalid", "Only the owner can change the creative mode.");
      const p = requireProgram(doc);
      p.creativeMode = op.mode;
      if (op.flexibleBeatLimit !== undefined) p.flexibleBeatLimit = op.flexibleBeatLimit;
      return doc;
    }
    case "setPresenterFraming":
      requireProgram(doc).presenterFraming = op.framing;
      return doc;
    case "rejectCuts": {
      const p = requireProgram(doc);
      p.proposedCuts = p.proposedCuts.filter((c) => !op.cutIds.includes(c.id));
      return doc;
    }
    case "setBeats":
      if (actor !== "user") {
        const lockedBeats = doc.beats.filter((b) => b.locked);
        for (const b of lockedBeats) {
          const n = op.beats.find((x) => x.id === b.id);
          if (!n || JSON.stringify(n) !== JSON.stringify(b)) throw new OperationError("locked", `Beat "${b.cue.phrase}" is locked.`);
        }
      }
      doc.beats = op.beats;
      return doc;
    case "updateBeat": {
      const b = findBeat(doc, op.beatId);
      if (b.locked && actor !== "user") throw new OperationError("locked", `Beat "${b.cue.phrase}" is locked.`);
      Object.assign(b, stripUndefined(op.patch));
      return doc;
    }
    case "setBeatAnchor": {
      const b = findBeat(doc, op.beatId);
      if (b.anchorLocked && actor !== "user") throw new OperationError("locked", "This anchor was placed by the owner and is locked.");
      b.anchor = op.anchor;
      b.anchorLocked = op.anchor ? op.lock : false;
      return doc;
    }
    case "mapBeatToTranscriptOccurrence": {
      const b = findBeat(doc, op.beatId);
      b.cue = { ...b.cue, occurrence: op.occurrence, sourceStartSec: op.sourceStartSec, sourceEndSec: op.sourceEndSec };
      b.status = "mapped";
      return doc;
    }
    case "setSeed":
      doc.seed = op.seed;
      return doc;
  }
}

function findTrack(doc: ProjectDocument, id: string) {
  const t = doc.audio.find((x) => x.id === id);
  if (!t) throw new OperationError("not_found", `Audio track ${id} does not exist.`);
  return t;
}

function findBeat(doc: ProjectDocument, id: string) {
  const b = doc.beats.find((x) => x.id === id);
  if (!b) throw new OperationError("not_found", `Beat ${id} does not exist.`);
  return b;
}

function requireProgram(doc: ProjectDocument) {
  if (!doc.program) throw new OperationError("invalid", "This project has no source recording program.");
  return doc.program;
}

/** Remove source ranges from keep segments, splitting segments where needed. */
export function subtractRanges<T extends { id: string; sourceInSec: number; sourceOutSec: number }>(
  keeps: T[],
  cuts: { sourceInSec: number; sourceOutSec: number }[],
): T[] {
  let out = keeps;
  for (const cut of cuts) {
    const next: T[] = [];
    for (const k of out) {
      if (cut.sourceOutSec <= k.sourceInSec || cut.sourceInSec >= k.sourceOutSec) {
        next.push(k);
        continue;
      }
      if (cut.sourceInSec > k.sourceInSec) next.push({ ...k, id: `${k.id}a`.slice(0, 64), sourceOutSec: cut.sourceInSec });
      if (cut.sourceOutSec < k.sourceOutSec) next.push({ ...k, id: `${k.id}b`.slice(0, 64), sourceInSec: cut.sourceOutSec });
    }
    out = next.filter((k) => k.sourceOutSec - k.sourceInSec > 0.02);
  }
  return out;
}

/** Re-add a previously cut source range to the EDL (undoing a cut), merging neighbours. */
export function restoreRange(edl: EdlEntry[], inSec: number, outSec: number, assetId: string): EdlEntry[] {
  const all = [...edl.filter((e) => e.review === "accepted"), { id: `r${Math.round(inSec * 1000)}`, sourceAssetId: assetId, sourceInSec: inSec, sourceOutSec: outSec, reason: "restored", review: "accepted" as const }].sort((a, b) => a.sourceInSec - b.sourceInSec);
  const merged: EdlEntry[] = [];
  for (const e of all) {
    const last = merged.at(-1);
    if (last && e.sourceInSec <= last.sourceOutSec + 1e-3) last.sourceOutSec = Math.max(last.sourceOutSec, e.sourceOutSec);
    else merged.push({ ...e });
  }
  return merged;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * A24 — strict vs flexible creative mode for assistant edits. Strict: the assistant may
 * refine owner-specified beats but never add one. Flexible: additions are marked as
 * assistant-originated, bounded in number, never overlap locked beats, stay inside the
 * output, use only media already in the project (no new spending) and introduce no
 * figures that are not approved facts or spoken in the cue.
 */
export function checkCreativeMode(before: ProjectDocument, after: ProjectDocument) {
  const prevIds = new Set(before.beats.map((b) => b.id));
  const added = after.beats.filter((b) => !prevIds.has(b.id));
  if (!added.length) return;
  const p = after.program;
  if (!p || p.creativeMode === "strict") {
    throw new OperationError("strict_mode", `Strict mode: only the beats you specified are used, so the assistant can't add “${added[0]!.cue.phrase}”. Switch to flexible mode to allow supporting additions.`);
  }
  const already = before.beats.filter((b) => b.origin === "assistant-flexible").length;
  if (already + added.length > p.flexibleBeatLimit) {
    throw new OperationError("flexible_limit", `Flexible mode allows at most ${p.flexibleBeatLimit} assistant-added beats.`);
  }
  const total = computeTimeline(after).totalFrames;
  const known = new Set<string>([...referencedAssetIdsOf(before)]);
  const facts = before.brief.approvedFacts.map((f) => f.text).join(" ");
  for (const b of added) {
    if (b.origin !== "assistant-flexible" || b.locked) throw new OperationError("invalid", "Assistant-added beats must be marked as flexible additions and cannot be locked.");
    if (b.assetId && !known.has(b.assetId)) throw new OperationError("flexible_asset", "Flexible additions can only use media already in the project (no new generation or spending).");
    for (const n of b.text.match(/\d[\d.,%]*/g) ?? []) {
      if (!facts.includes(n) && !b.cue.phrase.includes(n)) throw new OperationError("approved_claim", `“${b.text}” introduces the figure ${n}, which is not an approved fact.`);
    }
    if (b.outputFrame !== undefined) {
      if (b.outputFrame + b.durationFrames > total) throw new OperationError("timeline", `Beat “${b.cue.phrase}” would run past the end of the video.`);
      for (const l of after.beats.filter((x) => x.locked && x.outputFrame !== undefined)) {
        if (b.outputFrame < l.outputFrame! + l.durationFrames && l.outputFrame! < b.outputFrame + b.durationFrames) {
          throw new OperationError("locked", `Beat “${b.cue.phrase}” would overlap the locked beat “${l.cue.phrase}”.`);
        }
      }
    }
  }
}

function referencedAssetIdsOf(doc: ProjectDocument): string[] {
  const ids: string[] = [];
  for (const s of doc.scenes) for (const l of s.layers) if ((l.kind === "image" || l.kind === "video") && l.assetId) ids.push(l.assetId);
  for (const b of doc.beats) if (b.assetId) ids.push(b.assetId);
  for (const v of Object.values(doc.brief.inputs)) for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && /^ast_/.test(x)) ids.push(x);
  if (doc.brand.logoAssetId) ids.push(doc.brand.logoAssetId);
  return ids;
}

/**
 * Snap scene cuts to music markers (music lock). Each cut after the first scene moves to
 * the nearest marker of the chosen kinds that leaves both neighbours at least half a
 * second long; locked scenes keep their length and are reported when that blocks a fit.
 * The music itself is never moved or shortened.
 */
export function fitScenesToMarkers(input: ProjectDocument, kinds: ("section" | "downbeat" | "beat")[]): { doc: ProjectDocument; fitted: number; conflicts: string[] } {
  const doc = structuredClone(input);
  const fps = doc.format.fps;
  const minLen = Math.round(fps / 2);
  const marks = [...new Set(doc.markers.filter((m) => kinds.includes(m.kind)).map((m) => m.frame))].sort((a, b) => a - b);
  const conflicts: string[] = [];
  let fitted = 0;
  if (!marks.length) return { doc, fitted, conflicts: ["There are no markers of the selected kind; analyse the music or add markers first."] };
  let prevStart = 0;
  for (let i = 1; i < doc.scenes.length; i++) {
    const scene = doc.scenes[i]!;
    const prev = doc.scenes[i - 1]!;
    const cur = computeTimeline(doc).scenes[i]!;
    // The visible cut is where the incoming scene starts (overlap included).
    const target = marks.filter((m) => m - prevStart >= minLen + cur.overlapIn).reduce<number | null>((best, m) => (best === null || Math.abs(m - cur.start) < Math.abs(best - cur.start) ? m : best), null);
    if (target === null || target === cur.start) {
      prevStart = cur.start;
      continue;
    }
    if (prev.locked) {
      conflicts.push(`“${prev.purpose}” is locked, so the cut into “${scene.purpose}” can't move to ${(target / fps).toFixed(2)} s.`);
      prevStart = cur.start;
      continue;
    }
    prev.durationFrames = Math.max(minLen, prev.durationFrames + (target - cur.start));
    fitted++;
    prevStart = computeTimeline(doc).scenes[i]!.start;
  }
  // Music lock: the last scene ends exactly where the selected excerpt ends.
  const track = doc.musicLock.enabled ? doc.audio.find((t) => t.id === doc.musicLock.trackId) : undefined;
  if (track && track.sourceOutSec !== null && track.anchor.type === "absolute") {
    const end = track.anchor.startFrame + Math.round((track.sourceOutSec - track.sourceInSec) * fps);
    const last = doc.scenes.at(-1)!;
    const now = computeTimeline(doc).totalFrames;
    if (end !== now) {
      if (last.locked) conflicts.push(`“${last.purpose}” is locked, so the video can't end with the music at ${(end / fps).toFixed(2)} s.`);
      else if (last.durationFrames + (end - now) >= minLen) {
        last.durationFrames += end - now;
        fitted++;
      }
    }
  }
  return { doc, fitted, conflicts };
}

/** Point the shot scene's media layer at the accepted asset. */
function acceptShotMedia(s: Scene, assetId: string) {
  s.shot!.acceptedAssetId = assetId;
  s.shot!.status = "accepted";
  s.shot!.error = undefined;
  const media = s.layers.find((l) => (l.kind === "video" || l.kind === "image") && l.slot === "media");
  if (media && (media.kind === "video" || media.kind === "image")) media.assetId = assetId;
}
