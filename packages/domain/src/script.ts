import { z } from "zod";

/**
 * Script stage (Phase 2): the narration and on-screen line for each beat, written before the
 * storyboard and approved by the owner. The planner then builds one scene per beat and keeps the
 * narration verbatim, so what was approved is what gets voiced.
 */

export const SCRIPT_STYLES = {
  professor: {
    label: "University professor",
    wpm: 140,
    guide:
      "Narrate like a good university professor giving a clear lecture: precise, calm and explanatory. Define a term before using it, move from the concrete example to the general point, use complete sentences, and let one idea land before the next. Authoritative but warm; never salesy.",
  },
  plain: {
    label: "Plain and direct",
    wpm: 150,
    guide: "Plain, direct and concrete. Short declarative sentences, everyday words, one idea per sentence. No flourishes.",
  },
  conversational: {
    label: "Conversational",
    wpm: 155,
    guide: "Friendly and natural, as if explaining to a colleague: contractions, second person, a light touch of personality. Still specific; no filler.",
  },
  documentary: {
    label: "Documentary",
    wpm: 130,
    guide: "Measured documentary narration: observational, vivid, concrete detail, unhurried rhythm with room for pictures to breathe.",
  },
  energetic: {
    label: "Energetic",
    wpm: 170,
    guide: "Upbeat and punchy for social video: short lines, strong verbs, quick rhythm. Energy from specifics, not from hype words or exclamation marks.",
  },
} as const;
export type ScriptStyle = keyof typeof SCRIPT_STYLES;
export const SCRIPT_STYLE_IDS = Object.keys(SCRIPT_STYLES) as [ScriptStyle, ...ScriptStyle[]];

export const ScriptBeat = z.object({
  id: z.string().min(1).max(64),
  recipeSlot: z.string().max(40),
  purpose: z.string().max(80),
  narration: z.string().max(1200).default(""),
  onScreen: z.string().max(220).default(""),
  durationSec: z.number().min(1).max(120),
});
export type ScriptBeat = z.infer<typeof ScriptBeat>;

export const Script = z.object({
  style: z.enum(SCRIPT_STYLE_IDS),
  /** Extra direction from the owner, e.g. "for first-year students". */
  direction: z.string().max(400).default(""),
  /** Whether the beats carry a spoken voiceover (otherwise narration stays empty). */
  narrated: z.boolean(),
  status: z.enum(["draft", "approved"]),
  beats: z.array(ScriptBeat).min(1).max(40),
  /** Claude's short note on the structure it chose. */
  notes: z.string().max(1000).default(""),
  /** What happens after approval (chosen in the composer). */
  next: z.object({ planEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(), voiceId: z.string().max(120).optional() }).default({}),
});
export type Script = z.infer<typeof Script>;

export const wordCount = (s: string) => (s.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

/** Words that comfortably fit in `sec` seconds at the style's pace. */
export function wordBudget(style: ScriptStyle, sec: number): number {
  return Math.floor((SCRIPT_STYLES[style].wpm / 60) * sec);
}

/**
 * Stock phrasing that makes generated scripts sound generated. Checked deterministically; the
 * writer must remove every hit, and the owner sees any that remain after editing.
 */
const CLAUDISMS: [RegExp, string][] = [
  [/\bdelv(e|es|ing)\b/i, "delve"],
  [/\btapestry\b/i, "tapestry"],
  [/\btestament to\b/i, "a testament to"],
  [/\bin today'?s (fast[- ]paced|digital|modern|ever[- ]changing) (world|age|landscape)\b/i, "in today's … world"],
  [/\bever[- ](evolving|changing) (landscape|world)\b/i, "ever-evolving landscape"],
  [/\b(the )?(digital|business|tech) landscape\b/i, "the … landscape"],
  [/\bgame[- ]?changer\b/i, "game-changer"],
  [/\bunlock(s|ing)? (the|your|new)\b/i, "unlock the/your …"],
  [/\belevate(s|d)?\b/i, "elevate"],
  [/\bseamless(ly)?\b/i, "seamless"],
  [/\bembark(s|ing)? on\b/i, "embark on"],
  [/\bharness(ing)? the power\b/i, "harness the power"],
  [/\bcutting[- ]edge\b/i, "cutting-edge"],
  [/\brevolutioni[sz]e/i, "revolutionize"],
  [/\bleverag(e|es|ing)\b/i, "leverage"],
  [/\bsynerg/i, "synergy"],
  [/\brobust\b/i, "robust"],
  [/\bnavigat(e|ing) the (complexities|world|challenges)\b/i, "navigate the complexities"],
  [/\bin the realm of\b/i, "in the realm of"],
  [/\bit'?s (worth|important to) not(e|ing)\b/i, "it's worth noting"],
  [/\blook no further\b/i, "look no further"],
  [/\b(let'?s )?dive (in|into|deep)\b/i, "dive in/into"],
  [/\bdeep dive\b/i, "deep dive"],
  [/\bpicture this\b/i, "picture this"],
  [/\bimagine a world\b/i, "imagine a world"],
  [/\bhere'?s the (thing|kicker|catch)\b/i, "here's the thing"],
  [/\bbuckle up\b/i, "buckle up"],
  [/\bwhether you'?re an? .{1,40} or an? /i, "whether you're a … or a …"],
  [/\b(it'?s|this is) not just (a|an|about)\b/i, "not just a …"],
  [/\bmore than just\b/i, "more than just"],
  [/\bnot only .{1,60} but also\b/i, "not only … but also"],
  [/\b(it|this) isn'?t (about|just) .{1,50}[,;—–-]+ ?(it'?s|this is)\b/i, "it isn't X — it's Y"],
  [/\bthe best part\??\b/i, "the best part?"],
  [/\bat the end of the day\b/i, "at the end of the day"],
  [/\bin conclusion\b/i, "in conclusion"],
  [/\bstay tuned\b/i, "stay tuned"],
  [/\b(moreover|furthermore)\b/i, "moreover/furthermore"],
  [/\bexcit(ed|ing) to (announce|share|introduce)\b/i, "excited to announce"],
  [/\b(empower|empowering|empowers)\b/i, "empower"],
  [/\bsupercharge/i, "supercharge"],
  [/\bnext[- ]level\b/i, "next-level"],
  [/\bin a world where\b/i, "in a world where"],
  [/\bever wondered\b/i, "ever wondered"],
];

export interface ScriptIssue {
  beatId: string | null;
  kind: "claudism" | "dashes" | "exclamation" | "too_long" | "too_short" | "empty";
  message: string;
}

/** Deterministic style and timing checks for a script. */
export function lintScript(script: Pick<Script, "style" | "narrated" | "beats">): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  let dashes = 0;
  let words = 0;
  let seconds = 0;
  for (const b of script.beats) {
    const text = `${b.narration} ${b.onScreen}`;
    for (const [re, label] of CLAUDISMS) {
      const m = re.exec(text);
      if (m) issues.push({ beatId: b.id, kind: "claudism", message: `Stock phrasing "${m[0].trim()}" (${label}). Say it plainly and specifically.` });
    }
    dashes += (text.match(/—|–| - /g) ?? []).length;
    if ((b.narration.match(/!/g) ?? []).length > 1) issues.push({ beatId: b.id, kind: "exclamation", message: "More than one exclamation mark. Let the words carry the energy." });
    const w = wordCount(b.narration);
    words += w;
    seconds += b.durationSec;
    if (script.narrated) {
      const budget = wordBudget(script.style, b.durationSec);
      if (w > Math.ceil(budget * 1.15) + 1) issues.push({ beatId: b.id, kind: "too_long", message: `${w} words won't fit in ${b.durationSec}s at this pace (about ${budget}). Cut words or lengthen the beat.` });
    }
  }
  if (dashes > Math.max(1, Math.floor(script.beats.length / 3))) issues.push({ beatId: null, kind: "dashes", message: `${dashes} dashes. Use full stops and commas; keep dashes rare.` });
  if (script.narrated) {
    if (words === 0) issues.push({ beatId: null, kind: "empty", message: "The voiceover is empty." });
    else if (words < wordBudget(script.style, seconds) * 0.45) issues.push({ beatId: null, kind: "too_short", message: `Only ${words} words for ${Math.round(seconds)}s; the voiceover will leave long silences.` });
  }
  return issues;
}
