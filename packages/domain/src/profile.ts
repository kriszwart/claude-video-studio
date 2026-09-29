import { CreativeProfileSnapshot } from "./document";

/**
 * Creative profiles (FR-17): editing taste as validated data. Everything here is pure and
 * explicit: diffs are field-by-field, feedback becomes a *proposed* change the user saves,
 * and reference measurements map to traits with their evidence and a measured/interpreted
 * label. Nothing learns silently.
 */

export type ProfileData = Omit<CreativeProfileSnapshot, "profileId" | "version">;
export type ProfileField = keyof ProfileData;

export interface ProfileChange {
  field: ProfileField;
  from: unknown;
  to: unknown;
  /** Why: the feedback phrase or the measurement behind it. */
  because?: string;
}

const FIELDS: ProfileField[] = ["name", "pacing", "typeScale", "transition", "motionIntensity", "soundDensity", "textDensity", "framing", "preferred", "avoided"];

export function diffProfiles(a: Partial<ProfileData>, b: Partial<ProfileData>): ProfileChange[] {
  const out: ProfileChange[] = [];
  for (const f of FIELDS) {
    if (JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null)) out.push({ field: f, from: a[f] ?? null, to: b[f] ?? null });
  }
  return out;
}

export function applyChanges(p: ProfileData, changes: ProfileChange[]): ProfileData {
  const next = { ...p } as Record<string, unknown>;
  for (const c of changes) next[c.field] = c.to;
  const parsed = CreativeProfileSnapshot.parse(next);
  const { profileId: _p, version: _v, ...data } = parsed;
  return data;
}

const PACE = ["calm", "balanced", "fast"] as const;
const SOUND = ["minimal", "moderate", "rich"] as const;
const TEXT = ["sparse", "balanced", "dense"] as const;
const step = <T extends string>(scale: readonly T[], cur: T, d: number): T => scale[Math.max(0, Math.min(scale.length - 1, scale.indexOf(cur) + d))]!;
const round2 = (n: number) => Math.round(n * 100) / 100;
const addUnique = (list: string[], v: string) => (list.includes(v) ? list : [...list, v].slice(-20));

/** Explicit, inspectable feedback rules. Each rule names the phrases it reacts to. */
const RULES: { match: RegExp; apply: (p: ProfileData) => Partial<ProfileData> }[] = [
  { match: /\b(larger|bigger|increase(d)?)\b[^.,;]*\b(text|type|font|titles?|captions?)\b/i, apply: (p) => ({ typeScale: round2(Math.min(1.6, p.typeScale + 0.15)) }) },
  { match: /\b(smaller|reduce(d)?)\b[^.,;]*\b(text|type|font|titles?)\b/i, apply: (p) => ({ typeScale: round2(Math.max(0.7, p.typeScale - 0.15)) }) },
  { match: /\b(fewer|less|no|reduce)\b[^.,;]*\b(whooshe?s?|sound effects?|sfx|risers?)\b/i, apply: (p) => ({ soundDensity: step(SOUND, p.soundDensity, -1), avoided: addUnique(p.avoided, "whoosh effects") }) },
  { match: /\b(fewer|less|no|reduce|tone down)\b[^.,;]*\b(effects|animations?|motion|movement)\b/i, apply: (p) => ({ motionIntensity: round2(Math.max(0, p.motionIntensity - 0.2)), avoided: addUnique(p.avoided, "busy effects") }) },
  { match: /\b(more)\b[^.,;]*\b(energy|motion|movement|animation)\b/i, apply: (p) => ({ motionIntensity: round2(Math.min(1, p.motionIntensity + 0.2)) }) },
  { match: /\b(longer|slower)\b[^.,;]*\b(shots?|scenes?|explanations?|pacing|cuts?)\b|\bslow(er)? (it )?down\b/i, apply: (p) => ({ pacing: step(PACE, p.pacing, -1), preferred: addUnique(p.preferred, "longer explanation shots") }) },
  { match: /\b(faster|quicker|shorter)\b[^.,;]*\b(shots?|scenes?|pacing|cuts?)\b|\bspeed (it )?up\b/i, apply: (p) => ({ pacing: step(PACE, p.pacing, 1) }) },
  { match: /\b(keep|more|use)\b[^.,;]*\bsplit[- ]?screens?\b/i, apply: (p) => ({ framing: "split", preferred: addUnique(p.preferred, "split-screen explanations") }) },
  { match: /\b(less|fewer|shorter)\b[^.,;]*\b(text|words|copy)\b/i, apply: (p) => ({ textDensity: step(TEXT, p.textDensity, -1) }) },
  { match: /\b(simple|plain) (cuts?|transitions?)\b|\bjust cut\b/i, apply: () => ({ transition: "cut" }) },
  { match: /\b(soft|gentle|smooth) (fades?|transitions?)\b/i, apply: () => ({ transition: "fade" }) },
];

/**
 * Turn free-text feedback into a proposed profile change. Clauses that match no rule are
 * returned as "unmatched" (shown to the user) instead of being guessed at.
 */
export function proposeFromFeedback(p: ProfileData, feedback: string): { changes: ProfileChange[]; unmatched: string[] } {
  const clauses = feedback.split(/[.;\n]|,\s*(?:and\s+)?|\band\b/i).map((s) => s.trim()).filter((s) => s.length > 2);
  let cur = { ...p };
  const changes: ProfileChange[] = [];
  const unmatched: string[] = [];
  for (const clause of clauses) {
    const rule = RULES.find((r) => r.match.test(clause));
    if (!rule) {
      unmatched.push(clause);
      continue;
    }
    const patch = rule.apply(cur);
    for (const [field, to] of Object.entries(patch) as [ProfileField, unknown][]) {
      const from = cur[field];
      if (JSON.stringify(from) === JSON.stringify(to)) continue;
      const prior = changes.find((c) => c.field === field);
      if (prior) prior.to = to;
      else changes.push({ field, from, to, because: clause });
    }
    cur = { ...cur, ...patch } as ProfileData;
  }
  return { changes, unmatched };
}

// ---- Reference analysis → proposed traits ----

export interface ReferenceMeasurements {
  kind: "video" | "image";
  durationSec: number | null;
  /** Hard cuts detected (seconds). */
  cuts: number[];
  /** Cuts that pass through black (fade-through-black). */
  fadeCuts: number[];
  /** Mean inter-frame change score 0..1 (ffmpeg scene score) sampled across the clip. */
  meanMotion: number | null;
  hasAudio: boolean;
  loudnessLufs: number | null;
  /** Audio onsets per second (transient density). */
  onsetsPerSec: number | null;
  /** Fraction of the clip below the silence threshold. */
  silenceRatio: number | null;
  tempoBpm: number | null;
  /** Evidence frames: time and stored asset id. */
  frames: { timeSec: number; assetId: string }[];
}

export interface ProposedTrait {
  field: ProfileField | "intent";
  value: unknown;
  basis: "measured" | "interpretation" | "not measured";
  detail: string;
  evidence: { timeSec?: number; assetId?: string; metric?: string }[];
}

export function traitsFromMeasurements(m: ReferenceMeasurements): ProposedTrait[] {
  const t: ProposedTrait[] = [];
  const frameEv = m.frames.map((f) => ({ timeSec: f.timeSec, assetId: f.assetId }));
  if (m.kind === "image" || m.durationSec === null) {
    t.push({ field: "pacing", value: null, basis: "not measured", detail: "Only still images were supplied: shot length, motion and sound can't be measured.", evidence: frameEv });
    return t;
  }
  const shots = m.cuts.length + 1;
  const asl = m.durationSec / shots;
  t.push({
    field: "pacing",
    value: asl < 1.8 ? "fast" : asl > 4 ? "calm" : "balanced",
    basis: "measured",
    detail: `${shots} shots in ${m.durationSec.toFixed(1)} s: average shot length ${asl.toFixed(1)} s (${((m.cuts.length / m.durationSec) * 60).toFixed(0)} cuts/min).`,
    evidence: m.cuts.slice(0, 12).map((c) => ({ timeSec: c, metric: "cut" })),
  });
  if (m.cuts.length) {
    const fadeShare = m.fadeCuts.length / m.cuts.length;
    t.push({ field: "transition", value: fadeShare > 0.4 ? "fade" : "cut", basis: "measured", detail: `${m.fadeCuts.length} of ${m.cuts.length} transitions pass through black; the rest are hard cuts.`, evidence: (m.fadeCuts.length ? m.fadeCuts : m.cuts).slice(0, 6).map((c) => ({ timeSec: c, metric: fadeShare > 0.4 ? "fade" : "cut" })) });
  }
  if (m.meanMotion !== null) {
    // Scene scores are tiny for ordinary motion (≈0.001 slow push, ≈0.01 busy action): map on a log scale.
    const mi = Math.round(Math.max(0, Math.min(1, (Math.log10(Math.max(m.meanMotion, 1e-6)) + 3.5) / 2.5)) * 100) / 100;
    t.push({ field: "motionIntensity", value: mi, basis: "measured", detail: `Mean frame-to-frame change ${m.meanMotion.toFixed(3)} (scene score), mapped to motion ${Math.round(mi * 100)}%.`, evidence: frameEv });
  }
  if (!m.hasAudio) {
    t.push({ field: "soundDensity", value: null, basis: "not measured", detail: "The reference has no audio track, so sound wasn't analysed.", evidence: [] });
  } else if (m.onsetsPerSec !== null) {
    const sd = m.onsetsPerSec > 3 ? "rich" : m.onsetsPerSec < 1.2 ? "minimal" : "moderate";
    t.push({ field: "soundDensity", value: sd, basis: "measured", detail: `${m.onsetsPerSec.toFixed(1)} audio onsets/s, ${Math.round((m.silenceRatio ?? 0) * 100)}% near-silent${m.tempoBpm ? `, tempo ≈ ${Math.round(m.tempoBpm)} BPM` : ""}${m.loudnessLufs !== null ? `, ${m.loudnessLufs.toFixed(1)} LUFS` : ""}.`, evidence: [{ metric: "onset density" }] });
  }
  t.push({ field: "textDensity", value: null, basis: "not measured", detail: "On-screen text isn't read from video (no OCR); judge typography from the evidence frames.", evidence: frameEv });
  const energetic = asl < 2.5 && (m.onsetsPerSec ?? 0) > 2;
  t.push({ field: "intent", value: energetic ? "energetic, promotional" : asl > 4 ? "calm, explanatory" : "steady, informative", basis: "interpretation", detail: "An interpretation from pacing and sound density, not a measurement.", evidence: [] });
  return t;
}

/** Build profile data from the traits the user selected (measured values only). */
export function profileFromTraits(name: string, traits: ProposedTrait[], base: Partial<ProfileData> = {}): ProfileData {
  const data: Record<string, unknown> = { ...base, name };
  for (const tr of traits) if (tr.field !== "intent" && tr.basis === "measured" && tr.value !== null) data[tr.field] = tr.value;
  const { profileId: _p, version: _v, ...rest } = CreativeProfileSnapshot.parse(data);
  return rest;
}

/** Optional Markdown explanation of a profile (documentation only; never executed). */
export function profileMarkdown(p: ProfileData, meta: { version: number; evidence?: ProposedTrait[] }): string {
  const lines = [
    `# Creative profile: ${p.name} (v${meta.version})`,
    "",
    "Editing taste for Video Studio projects. This file describes a style; it is not an instruction set.",
    "",
    `- Pacing: ${p.pacing}`,
    `- Type scale: ${p.typeScale}×`,
    `- Transitions: ${p.transition}`,
    `- Motion intensity: ${Math.round(p.motionIntensity * 100)}%`,
    `- Sound density: ${p.soundDensity}`,
    `- Text density: ${p.textDensity}`,
    `- Framing: ${p.framing}`,
    p.preferred.length ? `- Prefer: ${p.preferred.join("; ")}` : "",
    p.avoided.length ? `- Avoid: ${p.avoided.join("; ")}` : "",
  ];
  if (meta.evidence?.length) {
    lines.push("", "## Evidence", "");
    for (const e of meta.evidence) lines.push(`- ${e.field} (${e.basis}): ${e.detail}${e.evidence.filter((x) => x.timeSec !== undefined).length ? ` — at ${e.evidence.filter((x) => x.timeSec !== undefined).slice(0, 4).map((x) => `${x.timeSec!.toFixed(2)}s`).join(", ")}` : ""}`);
  }
  return lines.filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n") + "\n";
}
