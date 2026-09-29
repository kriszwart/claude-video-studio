import { captionChunks, ProjectDocument, type CaptionCue, type Scene } from "@vs/domain";

/** An authentic moment selected from a collection, with clean cut points already measured. */
export interface SizzleQuote {
  collectionId?: string;
  assetId: string;
  transcriptId: string;
  sourceName: string;
  segmentIds: string[];
  /** Verbatim segments (source seconds) in spoken order. */
  segments: { startSec: number; endSec: number; text: string }[];
  clipInSec: number;
  clipOutSec: number;
  theme: string;
  speaker?: string;
  cutLevelsDb?: { in: number | null; out: number | null };
}

/** The sizzle recipe: opening energy → insight/outcome → reactions/community → invitation. */
export const SIZZLE_THEME_ORDER = ["energy", "insight", "outcome", "reaction", "invitation"] as const;

export function orderQuotes<T extends { theme: string }>(quotes: T[]): T[] {
  const rank = (t: string) => {
    const i = SIZZLE_THEME_ORDER.indexOf(t as (typeof SIZZLE_THEME_ORDER)[number]);
    return i < 0 ? 2.5 : i; // unthemed moments sit in the middle of the story
  };
  return quotes.map((q, i) => ({ q, i })).sort((a, b) => rank(a.q.theme) - rank(b.q.theme) || a.i - b.i).map((x) => x.q);
}

const THEME_LABEL: Record<string, string> = { energy: "Opening", insight: "Insight", outcome: "Outcome", reaction: "Reaction", invitation: "Invitation" };

/**
 * Insert one scene per quote before the template's closing scenes. Each scene plays exactly
 * the measured clip range with its own sound (never trimmed: the scene length is the clip
 * length), captions are the verbatim transcript chunked and timed by segment, and the only
 * added text is the user's event name and optional speaker credit.
 */
export function withQuotes(doc: ProjectDocument, quotes: SizzleQuote[], opts: { eventName: string; newId: (p: string) => string; maxSec?: number }): ProjectDocument {
  if (!quotes.length) throw new Error("Select at least one quote from the collection.");
  const fps = doc.format.fps;
  const ordered = orderQuotes(quotes);
  const scenes: Scene[] = [];
  const cues: CaptionCue[] = [];
  ordered.forEach((q, i) => {
    if (!q.segments.length || q.segments.length !== q.segmentIds.length) throw new Error("A quote has no transcript text.");
    const speechIn = q.segments[0]!.startSec;
    const speechOut = q.segments.at(-1)!.endSec;
    if (!(q.clipInSec <= speechIn && q.clipOutSec >= speechOut)) throw new Error("A quote's clip range cuts into its words.");
    const sceneId = opts.newId("scn");
    const frames = Math.max(1, Math.round((q.clipOutSec - q.clipInSec) * fps));
    const text = q.segments.map((s) => s.text.trim()).join(" ");
    const label = i === 0 ? opts.eventName : q.speaker ? q.speaker : "";
    scenes.push({
      id: sceneId,
      purpose: `${THEME_LABEL[q.theme] ?? "Moment"}: ${text.slice(0, 60)}`.slice(0, 80),
      recipeSlot: "quote",
      durationFrames: frames,
      locked: false,
      layout: "event-quote",
      background: { type: "color", color: "#000000" },
      transitionIn: { type: "cut", durationFrames: 0 },
      motionIntensity: 0.4,
      layers: [
        { id: `${sceneId}-media`, kind: "video", slot: "media", assetId: q.assetId, sourceInSec: q.clipInSec, sourceOutSec: q.clipOutSec, muted: false, fit: "cover", focal: { x: 0.5, y: 0.5 }, frame: "none", hidden: false, animation: { in: "none", delayFrames: 0, punchIn: 1 } },
        ...(label
          ? [{ id: `${sceneId}-credit`, kind: "text" as const, slot: "kicker", role: "kicker" as const, text: label.slice(0, 80), hidden: false, style: { scale: 1.6, backing: "solid" as const }, animation: { in: "slide" as const, delayFrames: 6, stagger: false } }]
          : []),
      ],
      script: { narration: "" },
      notes: `Source: ${q.sourceName} ${fmt(speechIn)}–${fmt(speechOut)}`.slice(0, 1000),
      status: { state: "ready", message: "" },
      quote: {
        collectionId: q.collectionId,
        assetId: q.assetId,
        transcriptId: q.transcriptId,
        sourceName: q.sourceName.slice(0, 200),
        segmentIds: q.segmentIds,
        speechInSec: speechIn,
        speechOutSec: speechOut,
        clipInSec: q.clipInSec,
        clipOutSec: q.clipOutSec,
        text,
        theme: q.theme,
        speaker: q.speaker ?? "",
        cutLevelsDb: q.cutLevelsDb ?? { in: null, out: null },
      },
    } as Scene);
    // Verbatim captions, each segment's chunks spread across that segment's spoken time.
    q.segments.forEach((seg, si) => {
      const chunks = captionChunks(seg.text, 7, 42);
      const segStart = Math.max(0, Math.round((seg.startSec - q.clipInSec) * fps));
      const segEnd = Math.min(frames, Math.max(segStart + 1, Math.round((seg.endSec - q.clipInSec) * fps)));
      const total = chunks.reduce((a, c) => a + c.length + 1, 0);
      let cursor = segStart;
      chunks.forEach((c, ci) => {
        const end = ci === chunks.length - 1 ? segEnd : Math.min(segEnd, cursor + Math.max(8, Math.round(((c.length + 1) / total) * (segEnd - segStart))));
        cues.push({ id: `cue_${sceneId}_${si}_${ci}`, text: c, anchor: { type: "scene", sceneId, offsetFrames: 0 }, startFrame: cursor, endFrame: Math.max(cursor + 1, end), timing: "segment" });
        cursor = end;
      });
    });
  });
  const next = ProjectDocument.parse({
    ...doc,
    scenes: [...scenes, ...doc.scenes],
    captions: { ...doc.captions, enabled: true, burnIn: true, style: "boxed", position: "bottom", cues: [...cues, ...doc.captions.cues] },
  });
  const totalSec = next.scenes.reduce((a, s, i) => a + s.durationFrames - (i ? s.transitionIn.durationFrames : 0), 0) / fps;
  if (opts.maxSec && totalSec > opts.maxSec + 0.5) {
    throw new Error(`The selected quotes run ${totalSec.toFixed(1)} s, longer than ${opts.maxSec} s. Remove a quote (quotes are never trimmed mid-sentence).`);
  }
  return next;
}

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(1).padStart(4, "0")}`;
}
