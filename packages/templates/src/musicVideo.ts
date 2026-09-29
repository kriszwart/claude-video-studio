/**
 * T6 music video builder: one scene per analysed section inside the selected excerpt, so
 * cuts land on section markers and the total length equals the excerpt exactly. Visuals
 * are procedural (shapes/type); a repeated motif evolves in scale and colour and peaks in
 * the finale; downbeat accents are driven by the (editable) markers, not baked in.
 */
import { ProjectDocument, type CaptionCue, type Layer, type Scene } from "@vs/domain";

export interface AnalysedSection {
  startSec: number;
  endSec: number;
  label: string;
  energy: number;
}

export interface BuildMusicVideoOptions {
  sections: AnalysedSection[];
  excerpt: { inSec: number; outSec: number };
  songTitle: string;
  artist: string;
  motif: "ring" | "circle" | "blob" | "bars";
  lyrics: string[];
  newId: (prefix: string) => string;
}

function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const valid = (h: string) => /^#[0-9a-f]{6}$/i.test(h);
  if (!valid(a) || !valid(b)) return valid(a) ? a : "#222222";
  const [x, y] = [p(a), p(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** Sections clipped to the excerpt; slivers shorter than 1.5 s merge into a neighbour. */
export function excerptSections(sections: AnalysedSection[], inSec: number, outSec: number): AnalysedSection[] {
  const clipped = sections
    .map((s) => ({ ...s, startSec: Math.max(inSec, s.startSec), endSec: Math.min(outSec, s.endSec) }))
    .filter((s) => s.endSec - s.startSec > 0.01);
  const out: AnalysedSection[] = [];
  for (const s of clipped) {
    const last = out.at(-1);
    if (last && s.endSec - s.startSec < 1.5) last.endSec = s.endSec;
    else if (last && last.endSec - last.startSec < 1.5) Object.assign(last, { endSec: s.endSec, label: s.label, energy: s.energy });
    else out.push({ ...s });
  }
  if (!out.length) out.push({ startSec: inSec, endSec: outSec, label: "section", energy: 1 });
  out[0]!.startSec = inSec;
  out.at(-1)!.endSec = outSec;
  return out;
}

export function buildMusicVideoScenes(doc: ProjectDocument, o: BuildMusicVideoOptions): ProjectDocument {
  const fps = doc.format.fps;
  const secs = excerptSections(o.sections, o.excerpt.inSec, o.excerpt.outSec);
  const c = doc.brand.colors as Record<string, string>;
  const n = secs.length;
  const scenes: Scene[] = secs.map((sec, i) => {
    const id = o.newId("scn");
    const l = (k: number) => `${id}-l${k}`;
    const t = n === 1 ? 1 : i / (n - 1);
    const finale = i === n - 1 && n > 1;
    const loud = sec.energy >= 0.6 || /chorus|peak|drop/.test(sec.label);
    // Palette evolves from primary toward accent across the video; loud sections run hotter.
    const bgFrom = mix(c.background ?? "#0b0b12", c.primary ?? "#4f46e5", 0.25 + 0.5 * t);
    const bgTo = mix(c.primary ?? "#4f46e5", c.accent ?? "#f59e0b", loud ? 0.35 + 0.4 * t : 0.1 + 0.2 * t);
    const motifScale = 0.35 + 0.45 * t + (loud ? 0.15 : 0);
    const motifBox = { x: 0.5 - motifScale / 2, y: 0.5 - (motifScale * 16) / 9 / 2, w: motifScale, h: (motifScale * 16) / 9 };
    const layers: Layer[] = [
      { id: l(0), kind: "shape", slot: "decor", shape: o.motif, color: loud ? "brand.accent" : "brand.secondary", box: motifBox, hidden: false, animation: { in: "pop", delayFrames: 0, loop: loud ? "pulse" : "drift" } } as Layer,
    ];
    if (loud || finale) layers.push({ id: l(1), kind: "shape", slot: "decor", shape: "bars", color: "brand.accent", box: { x: 0.05, y: 0.72, w: 0.9, h: 0.26 }, hidden: false, animation: { in: "rise", delayFrames: 0, loop: "none" } } as Layer);
    // Titles sit in the upper band so lyrics (centre) never collide with them.
    const title = o.artist ? `${o.songTitle} — ${o.artist}` : o.songTitle;
    if (i === 0) layers.push({ id: l(3), kind: "text", slot: "kicker", role: "headline", text: title, hidden: false, style: { scale: 0.8, backing: "none" }, animation: { in: "type", delayFrames: 12, stagger: true } } as Layer);
    if (finale) layers.push({ id: l(4), kind: "text", slot: "kicker", role: "headline", text: o.songTitle, hidden: false, style: { scale: 1, backing: "none" }, animation: { in: "pop", delayFrames: Math.round(fps * 0.5), stagger: false } } as Layer);
    return {
      id,
      purpose: `${sec.label.charAt(0).toUpperCase()}${sec.label.slice(1)} ${(sec.startSec - o.excerpt.inSec).toFixed(1)}s`,
      recipeSlot: sec.label,
      durationFrames: Math.round((sec.endSec - o.excerpt.inSec) * fps) - Math.round((sec.startSec - o.excerpt.inSec) * fps),
      locked: false,
      layout: "lyric",
      background: { type: "gradient", from: bgFrom, to: bgTo, angle: 140 + 40 * t },
      transitionIn: { type: "cut", durationFrames: 0 },
      motionIntensity: Math.min(1, 0.45 + 0.4 * t + (loud ? 0.15 : 0)),
      layers,
      script: { narration: "" },
      notes: `Music ${sec.startSec.toFixed(2)}–${sec.endSec.toFixed(2)} s (${sec.label}, energy ${sec.energy}). Cut lands on the section marker.`,
      status: { state: "ready", message: "" },
    } as Scene;
  });

  // Lyrics: owner-supplied lines, spread across non-intro sections. Timing is an estimate
  // (no alignment was measured) and each cue is editable.
  const cues: CaptionCue[] = [];
  const vocal = secs.map((s, i) => ({ s, i })).filter(({ s }) => !/intro|outro/.test(s.label));
  const lines = o.lyrics.map((x) => x.trim()).filter(Boolean);
  if (lines.length && vocal.length) {
    const per = Math.ceil(lines.length / vocal.length);
    let k = 0;
    for (const { s } of vocal) {
      const chunk = lines.slice(k, k + per);
      k += per;
      const span = (s.endSec - s.startSec) / Math.max(1, chunk.length);
      chunk.forEach((text, j) => {
        const a = Math.round((s.startSec - o.excerpt.inSec + j * span) * fps);
        cues.push({ id: o.newId("cue"), text: text.slice(0, 300), anchor: { type: "absolute", startFrame: 0 }, startFrame: a, endFrame: Math.max(a + 1, Math.round((s.startSec - o.excerpt.inSec + (j + 1) * span) * fps) - 3), timing: "estimated" });
      });
    }
  }

  return ProjectDocument.parse({
    ...doc,
    scenes,
    captions: { ...doc.captions, enabled: cues.length > 0, style: "bold", position: "middle", cues },
    musicAccents: { enabled: true, on: "downbeat", sectionFlash: true, strength: 0.6 },
  });
}
