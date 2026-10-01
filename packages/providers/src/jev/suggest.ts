import { SCRIPT_STYLES, SCRIPT_STYLE_IDS, type ScriptStyle } from "@vs/domain";
import { confidentChoice, type JevAnswer, type JevQuestion } from "./client";

/**
 * Live composer suggestions: while the owner types the request, Jev picks a template,
 * orientation, length, writing style and whether to narrate. Suggestions only — the owner
 * applies them with a click, and Claude still writes the script and plans the storyboard.
 */

export interface SuggestTemplate {
  id: string;
  name: string;
  description: string;
  supportedAspects: string[];
  duration: { minSec: number; maxSec: number; defaultSec: number };
  /** Built from the owner's own recording (a required video input). */
  needsFootage?: boolean;
}

export interface ComposerSuggestion {
  /** needsRecording: the template is built from the owner's recording, and none is attached yet. */
  templateId?: { value: string; confidence: number; needsRecording?: boolean };
  aspect?: { value: "16:9" | "9:16" | "1:1"; confidence: number };
  durationSec?: { value: number; confidence: number };
  scriptStyle?: { value: ScriptStyle; confidence: number };
  narration?: { value: boolean; confidence: number };
}

const ASPECTS = {
  "16:9": "Landscape: YouTube, websites, presentations, TV, laptops",
  "9:16": "Vertical: TikTok, Reels, Shorts, stories, phones",
  "1:1": "Square: social feeds such as Instagram or LinkedIn posts",
} as const;

export const LENGTHS = [15, 30, 45, 60, 90, 120] as const;
const LENGTH_HINT: Record<number, string> = {
  15: "About 15 seconds: a teaser, ad bumper or social hook",
  30: "About 30 seconds: a short ad, launch teaser or social video",
  45: "About 45 seconds: a short explainer or showreel",
  60: "About a minute: an explainer, product launch or lesson intro",
  90: "About a minute and a half: a fuller explainer or story",
  120: "About two minutes: a lesson, walkthrough or longer story",
};

export function composerQuestions(templates: SuggestTemplate[], chosen: SuggestTemplate | null): Record<string, JevQuestion> {
  const q: Record<string, JevQuestion> = {};
  if (!chosen && templates.length > 1) {
    q.template = {
      type: "choice",
      instructions: "Which video template best fits this request? Judge by the kind of video asked for, not by brand names.",
      criteria: Object.fromEntries(templates.map((t) => [t.id, `${t.name}: ${t.description}`.slice(0, 300)])),
    };
  }
  const aspects = (chosen?.supportedAspects ?? Object.keys(ASPECTS)).filter((a): a is keyof typeof ASPECTS => a in ASPECTS);
  if (aspects.length > 1) q.aspect = { type: "choice", instructions: "Which orientation fits where this video will be watched? If the request doesn't say, prefer landscape.", criteria: Object.fromEntries(aspects.map((a) => [a, ASPECTS[a]])) };
  const lengths = LENGTHS.filter((s) => !chosen || (s >= chosen.duration.minSec && s <= chosen.duration.maxSec));
  if (lengths.length > 1) q.length = { type: "choice", instructions: "How long should this video be? Use a length stated in the request; otherwise judge from what it has to say.", criteria: Object.fromEntries(lengths.map((s) => [String(s), LENGTH_HINT[s]!])) };
  q.style = { type: "choice", instructions: "Which writing style suits the voiceover and on-screen words for this request?", criteria: Object.fromEntries(SCRIPT_STYLE_IDS.map((id) => [id, `${SCRIPT_STYLES[id].label}: ${SCRIPT_STYLES[id].guide}`.slice(0, 300)])) };
  q.narrated = { type: "noul", instructions: "Should this video have a spoken voiceover?", criteria: { true: "Someone should narrate it (explainers, launches, stories, lessons)", false: "Music and on-screen text only, or the request says no voice, or it is the owner's own recording" } };
  return q;
}

export function interpretComposer(answers: Record<string, JevAnswer>, templates: SuggestTemplate[], chosen: SuggestTemplate | null, opts: { footageAttached?: boolean } = {}): ComposerSuggestion {
  const out: ComposerSuggestion = {};
  const t = confidentChoice(answers.template, templates.map((x) => x.id));
  if (t) out.templateId = templates.find((x) => x.id === t.value)?.needsFootage && !opts.footageAttached ? { ...t, needsRecording: true } : t;
  const target = chosen ?? (t ? templates.find((x) => x.id === t.value) ?? null : null);
  const a = confidentChoice(answers.aspect, target?.supportedAspects ?? Object.keys(ASPECTS));
  if (a) out.aspect = { value: a.value as keyof typeof ASPECTS, confidence: a.confidence };
  const l = confidentChoice(answers.length, LENGTHS.map(String));
  if (l) {
    const sec = Number(l.value);
    const fits = !target || (sec >= target.duration.minSec && sec <= target.duration.maxSec);
    if (fits) out.durationSec = { value: sec, confidence: l.confidence };
  }
  const s = confidentChoice(answers.style, [...SCRIPT_STYLE_IDS]);
  if (s) out.scriptStyle = { value: s.value as ScriptStyle, confidence: s.confidence };
  const n = answers.narrated;
  if (n?.type === "noul" && typeof n.probability === "number") {
    if (n.probability >= 0.65) out.narration = { value: true, confidence: n.probability };
    else if (n.probability <= 0.35) out.narration = { value: false, confidence: 1 - n.probability };
  }
  return out;
}
