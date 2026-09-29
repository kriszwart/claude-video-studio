import { z } from "zod";
import {
  AudioTrack,
  Background,
  BrandSnapshot,
  CaptionCue,
  Captions,
  CreativeProfileSnapshot,
  EditorialBeat,
  Id,
  Layer,
  LayerBox,
  MusicMarker,
  Program,
  ProjectDocument,
  Scene,
  TextLayer,
  Transition,
} from "./document";
import { AspectRatio, SafeAreaPresetIdSchema } from "./format";
import { validateTimeline } from "./timeline";

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
  z.object({ op: z.literal("setMusicLock"), enabled: z.boolean(), trackId: Id.optional() }),
  z.object({ op: z.literal("setProgram"), program: Program }),
  z.object({ op: z.literal("proposeCuts"), cuts: Program.shape.proposedCuts.unwrap() }),
  z.object({ op: z.literal("acceptCuts"), cutIds: z.array(Id).min(1) }),
  z.object({ op: z.literal("rejectCuts"), cutIds: z.array(Id).min(1) }),
  z.object({ op: z.literal("setBeats"), beats: z.array(EditorialBeat).max(200) }),
  z.object({ op: z.literal("updateBeat"), beatId: Id, patch: EditorialBeat.omit({ id: true }).partial() }),
  z.object({ op: z.literal("setBeatAnchor"), beatId: Id, anchor: z.object({ x: Unit, y: Unit }).nullable(), lock: z.boolean().default(true) }),
  z.object({ op: z.literal("mapBeatToTranscriptOccurrence"), beatId: Id, occurrence: z.number().int().min(1), sourceStartSec: z.number().min(0), sourceEndSec: z.number().min(0) }),
  z.object({ op: z.literal("setSeed"), seed: z.number().int() }),
]);
export type Operation = z.infer<typeof Operation>;

export type Actor = "user" | "assistant" | "bulk" | "system";

export class OperationError extends Error {
  constructor(
    public code: "not_found" | "locked" | "approved_claim" | "invalid" | "timeline" | "conflict",
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
  "addLayer",
  "removeLayer",
  "setSceneDuration",
  "setSceneTransition",
  "setSceneBackground",
  "setSceneLayout",
  "setSceneMotion",
  "setSceneScript",
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
    case "setSceneScript":
      sceneOp!.script = { narration: op.narration };
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
    case "setMusicLock":
      doc.musicLock = { enabled: op.enabled, trackId: op.trackId };
      return doc;
    case "setProgram":
      doc.program = op.program;
      return doc;
    case "proposeCuts":
      requireProgram(doc).proposedCuts = op.cuts;
      return doc;
    case "acceptCuts": {
      const p = requireProgram(doc);
      const accepted = p.proposedCuts.filter((c) => op.cutIds.includes(c.id));
      p.edl = subtractRanges(p.edl, accepted);
      p.proposedCuts = p.proposedCuts.filter((c) => !op.cutIds.includes(c.id));
      return doc;
    }
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

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
