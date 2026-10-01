/**
 * Talking-head program builder (T5 and presets P1/P4/P5, Fast Social). Turns the
 * (corrected) transcript into sections → scenes that each cover a source range, so the
 * speech itself is never re-timed: cuts change durations through the EDL only.
 *
 * Every style reuses the same source asset and transcript; only the document differs.
 */
import { sketchItemsFromText } from "@vs/compositor";
import {
  findPhraseOccurrences,
  keptStart,
  programCaptionCues,
  ProjectDocument,
  sectionsFromTranscript,
  syncProgramScenes,
  takeaway,
  type EditorialBeat,
  type Layer,
  type Scene,
  type TranscriptSection,
  type TranscriptSegment,
} from "@vs/domain";

export type ProgramStyle = NonNullable<ProjectDocument["program"]>["style"];

export interface BuildProgramOptions {
  segments: TranscriptSegment[];
  sourceDurationSec: number;
  newId: (prefix: string) => string;
  /** Uploaded visuals for sourced inserts / B-roll (never generated here). */
  bRollAssetIds?: string[];
  /** Replace existing beats (a fresh build); otherwise beats are kept and re-resolved elsewhere. */
  resetBeats?: boolean;
}

const INK = "#1f2937";
const PAPER = "#f7f4ec";

function text(id: string, slot: string, role: Extract<Layer, { kind: "text" }>["role"], value: string, o: { scale?: number; color?: string; backing?: "none" | "solid" | "translucent"; delay?: number; anim?: "rise" | "fade" | "pop" | "type" } = {}): Layer {
  return {
    id,
    kind: "text",
    slot,
    role,
    text: value,
    hidden: false,
    style: { scale: o.scale ?? 1, color: o.color, backing: o.backing ?? "none" },
    animation: { in: o.anim ?? "rise", delayFrames: Math.round((o.delay ?? 0) * 30), stagger: false },
  } as Layer;
}

function sketchLayer(id: string, slot: string, items: string[], labels: string[], accent: string): Layer {
  return {
    id,
    kind: "graphics",
    slot,
    backend: "skia",
    component: "sketch",
    componentVersion: 1,
    params: { items: items.join("|"), labels: labels.join("|"), ink: INK, accent, drawSec: 1.4 },
    seed: 3,
    hidden: false,
  } as Layer;
}

function sceneFor(sec: TranscriptSection, i: number, n: number, style: ProgramStyle, doc: ProjectDocument, newId: (p: string) => string): Scene {
  const id = newId("scn");
  const l = (k: number) => `${id}-l${k}`;
  const line = takeaway(sec.text, style === "social" ? 44 : 56);
  const topic = String(doc.brief.inputs.topic ?? "").trim() || doc.title;
  const accent = typeof doc.brand.colors.accent === "string" ? doc.brand.colors.accent : "#f59e0b";
  const stepNo = sec.kind === "step" ? i : 0;
  const purpose = sec.kind === "intro" ? "Introduction" : sec.kind === "outro" ? "Wrap-up" : sec.kind === "step" ? `Step ${stepNo}` : `Section ${i + 1}`;
  const base: Scene = {
    id,
    purpose,
    recipeSlot: `section-${i + 1}`,
    durationFrames: 1,
    locked: false,
    layout: "presenter-full",
    background: { type: "color", color: "brand.background" },
    transitionIn: { type: "cut", durationFrames: 0 },
    motionIntensity: 0.5,
    layers: [],
    script: { narration: "" },
    notes: `Source ${sec.startSec.toFixed(2)}–${sec.endSec.toFixed(2)} s: ${sec.text.slice(0, 160)}`,
    status: { state: "ready", message: "" },
    sourceRange: { startSec: sec.startSec, endSec: sec.endSec },
  } as Scene;

  switch (style) {
    case "whiteboard": {
      const items = sketchItemsFromText(sec.text, 3);
      // Alternate full-screen illustration and presenter split (the voice continues throughout).
      const full = sec.kind !== "intro" && i % 2 === 1;
      base.background = { type: "color", color: PAPER };
      base.layout = full ? "whiteboard" : "presenter-split";
      base.layers = [
        text(l(0), "headline", "headline", sec.kind === "intro" ? topic : sec.kind === "step" ? `Step ${stepNo}` : sec.kind === "outro" ? "Done" : line, { color: INK, scale: 1.1 }),
        sketchLayer(l(1), "overlay", items.length ? items : ["idea"], full ? [line] : [], accent),
        ...(full ? [] : [text(l(2), "label", "body", line, { color: INK, scale: 0.9, delay: 0.6 })]),
      ];
      return base;
    }
    case "course": {
      base.background = { type: "gradient", from: "brand.background", to: "brand.surface", angle: 160 };
      if (i === 0) {
        base.layout = "lesson-intro";
        base.layers = [text(l(0), "kicker", "kicker", doc.brief.productName || "Lesson", { color: "brand.accent", backing: "translucent" }), text(l(1), "headline", "headline", doc.title, { backing: "translucent", scale: 1.1 })];
      } else {
        base.layout = "lesson-takeaway";
        base.layers = [
          text(l(0), "kicker", "kicker", sec.kind === "outro" ? "Recap" : `Takeaway ${i}`, { color: "brand.accent" }),
          text(l(1), "headline", "headline", line, { scale: 1.25 }),
        ];
      }
      return base;
    }
    case "social": {
      base.layout = "presenter-full";
      base.motionIntensity = 0.9;
      base.layers = i === 0 ? [text(l(0), "headline", "headline", topic, { backing: "solid", scale: 1.1, anim: "pop" })] : [];
      return base;
    }
    case "presenter-intro":
    case "balanced":
    default: {
      base.layout = "presenter-full";
      base.layers = i === 0 && doc.brief.productName ? [text(l(0), "label", "label", doc.brief.productName, { backing: "translucent", delay: 0.4 })] : [];
      return base;
    }
  }
}

/** Beats for sourced visual inserts (P1) / moving B-roll (social): one per section start while visuals last. */
function insertBeats(sections: TranscriptSection[], segments: TranscriptSegment[], assets: string[], style: ProgramStyle, newId: (p: string) => string): EditorialBeat[] {
  if (!assets.length || (style !== "presenter-intro" && style !== "social" && style !== "balanced")) return [];
  const out: EditorialBeat[] = [];
  const targets = sections.filter((s) => s.kind !== "intro" || sections.length === 1);
  for (const [k, sec] of targets.entries()) {
    const asset = assets[k];
    if (!asset) break;
    const words = sec.text.replace(/^(first|second|third|fourth|fifth|next|then|finally|lastly),?\s*/i, "").split(/\s+/).slice(0, 3).join(" ");
    const occ = findPhraseOccurrences(segments, words).find((o) => o.startSec >= sec.startSec - 0.01 && o.startSec < sec.endSec);
    if (!occ) continue;
    out.push({
      id: newId("beat"),
      cue: { phrase: words, occurrence: occ.occurrence, sourceStartSec: occ.startSec, sourceEndSec: occ.endSec },
      message: `Show the supplied visual while "${words}…" is said.`,
      visualAction: style === "social" ? "b-roll" : "image",
      text: "",
      assetId: asset,
      anchor: style === "social" ? { x: 0.5, y: 0.69 } : { x: k % 2 === 0 ? 0.76 : 0.24, y: 0.34 },
      anchorLocked: false,
      durationFrames: style === "social" ? 75 : 90,
      emphasis: "medium",
      backing: "translucent",
      mode: "strict",
      locked: false,
      origin: "user",
      status: "mapped",
    });
  }
  return out;
}

/**
 * (Re)build program scenes, captions and inserts from the transcript. Keeps the EDL, the
 * source, owner corrections and (unless resetBeats) existing beats; replaces unlocked scenes.
 */
export function buildProgramScenes(doc: ProjectDocument, opts: BuildProgramOptions): ProjectDocument {
  const p = doc.program;
  if (!p) throw new Error("This project has no source recording.");
  const style = p.style;
  // Headlines and inserts come only from speech that is still in the edit.
  const kept = opts.segments.filter((g) => keptStart(doc, g.startSec, g.endSec) !== null);
  const sections = sectionsFromTranscript(kept, opts.sourceDurationSec, { maxSections: style === "social" ? 8 : 6 });
  const scenes = sections.map((s, i) => sceneFor(s, i, sections.length, style, doc, opts.newId));
  const captionStyle = style === "social" ? { maxWords: 3, maxChars: 20 } : { maxWords: 7, maxChars: 42 };
  const cues = programCaptionCues(opts.segments, p.sourceAssetId, captionStyle);
  const beats = opts.resetBeats || !doc.beats.length ? insertBeats(sections, opts.segments, opts.bRollAssetIds ?? [], style, opts.newId) : doc.beats;
  const next = ProjectDocument.parse({
    ...doc,
    scenes,
    beats,
    captions: {
      ...doc.captions,
      enabled: true,
      style: style === "social" ? "bold" : "boxed",
      position: "bottom",
      cues: [...doc.captions.cues.filter((c) => !(c.anchor.type === "source" && c.id.startsWith("cue_"))), ...cues],
    },
    program: { ...p, presenterFraming: style === "course" ? "rounded-inset" : p.presenterFraming },
  });
  return syncProgramScenes(next);
}
