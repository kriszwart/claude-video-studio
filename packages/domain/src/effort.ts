/**
 * The composer's single effort dial (Phase 2). It stands in for model settings: how hard Claude
 * works on the brief and whether, and how thoroughly, it plans the storyboard.
 * Quick uses the template's built-in scene structure as is.
 */
export type ClaudeEffortSetting = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_LEVELS = {
  quick: { compose: "low", plan: null, label: "Quick", note: "Claude fills in the template; its built-in scene structure is used as is." },
  standard: { compose: "medium", plan: "medium", label: "Standard", note: "Claude also plans a storyboard for your request." },
  high: { compose: "medium", plan: "high", label: "High", note: "A more considered storyboard. Takes longer." },
  max: { compose: "high", plan: "max", label: "Max", note: "Claude's most thorough planning. Slowest, and uses the most of your plan." },
} as const satisfies Record<string, { compose: ClaudeEffortSetting; plan: ClaudeEffortSetting | null; label: string; note: string }>;
export type EffortLevel = keyof typeof EFFORT_LEVELS;
export const EFFORT_ORDER: EffortLevel[] = ["quick", "standard", "high", "max"];

/** Claude requests one composer run may make, counting validation repairs (at most two per step). */
export function claudeRequestRange(effort: EffortLevel): [number, number] {
  return EFFORT_LEVELS[effort].plan ? [2, 6] : [1, 3];
}
