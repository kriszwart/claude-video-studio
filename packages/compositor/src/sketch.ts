/**
 * Keyword vocabulary for the whiteboard "sketch" graphics component. Shared by the
 * template builder (to choose illustrations from transcript text) and the Skia runtime.
 */
export const SKETCH_ICON_NAMES = ["toast", "avocado", "bowl", "knife", "spread", "chili", "lemon", "salt", "clock", "check", "bulb", "plate", "laptop", "calendar", "person", "star", "heart", "arrow", "idea"] as const;

export const SKETCH_KEYWORDS: [RegExp, string][] = [
  [/toast|bread|sourdough|slice/i, "toast"],
  [/avocado/i, "avocado"],
  [/mash|bowl|mix|stir/i, "bowl"],
  [/spread|butter/i, "spread"],
  [/knife|cut|chop/i, "knife"],
  [/chil+i|pepper|spice|flake/i, "chili"],
  [/lemon|lime|juice/i, "lemon"],
  [/salt/i, "salt"],
  [/minute|time|hour|quick|fast|clock/i, "clock"],
  [/done|that's it|finish|ready|check/i, "check"],
  [/breakfast|plate|serve|eat|meal/i, "plate"],
  [/plan|calendar|week|day|schedule/i, "calendar"],
  [/app|tool|laptop|software|edit|video|screen/i, "laptop"],
  [/idea|tip|learn|remember|why/i, "idea"],
  [/you|me|i'm|team|people|hi\b/i, "person"],
  [/best|great|favourite|favorite/i, "star"],
  [/love|like/i, "heart"],
];
export function sketchIconFor(keyword: string, known: readonly string[] = SKETCH_ICON_NAMES): string {
  const k = keyword.trim().toLowerCase();
  if (known.includes(k)) return k;
  for (const [re, icon] of SKETCH_KEYWORDS) if (re.test(keyword)) return icon;
  return "idea";
}


/** Up to `max` distinct illustratable keywords found in text, in order of appearance. */
export function sketchItemsFromText(text: string, max = 3): string[] {
  const out: string[] = [];
  for (const word of text.split(/[^\p{L}']+/u)) {
    if (!word) continue;
    if (!SKETCH_KEYWORDS.some(([re]) => re.test(word))) continue;
    const icon = sketchIconFor(word);
    if (!out.includes(icon)) out.push(icon);
    if (out.length >= max) break;
  }
  return out;
}
