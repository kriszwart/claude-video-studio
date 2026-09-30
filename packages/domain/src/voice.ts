import { z } from "zod";

/**
 * Per-scene voice direction (Phase 2): how a line should be delivered. Structured so every
 * provider can honour what it supports, and the UI can say exactly what each voice will use.
 */
export const VoiceDirection = z.object({
  pace: z.enum(["slower", "normal", "faster"]).default("normal"),
  energy: z.enum(["calm", "neutral", "lively"]).default("neutral"),
  /** Free-text delivery note, e.g. "warm; stress 'focus'". Only some voices can use it. */
  note: z.string().max(200).default(""),
});
export type VoiceDirection = z.infer<typeof VoiceDirection>;

export const NEUTRAL_DIRECTION: VoiceDirection = { pace: "normal", energy: "neutral", note: "" };

/** Speech-rate multiplier for a pace setting (applied on top of the narration's overall rate). */
export const PACE_RATE = { slower: 0.9, normal: 1, faster: 1.1 } as const;

export function isNeutralDirection(d: VoiceDirection | undefined): boolean {
  return !d || (d.pace === "normal" && d.energy === "neutral" && !d.note.trim());
}

export type VoiceKind = "local" | "elevenlabs" | "omnivoice";
/** Which parts of a direction each kind of voice actually uses. */
export const DIRECTION_SUPPORT: Record<VoiceKind, { pace: boolean; energy: boolean; note: boolean; how: string }> = {
  local: { pace: true, energy: false, note: false, how: "Built-in voices follow pace only." },
  elevenlabs: { pace: true, energy: true, note: false, how: "ElevenLabs follows pace (speed) and energy (stability and style); free-text notes aren't supported by its standard models." },
  omnivoice: { pace: true, energy: true, note: true, how: "OmniVoice follows pace (speed); energy and notes are sent as spoken instructions — whether they're honoured depends on the OmniVoice server and voice." },
};

export function voiceKind(voiceId: string): VoiceKind {
  return voiceId.startsWith("elevenlabs:") ? "elevenlabs" : voiceId.startsWith("omnivoice:") ? "omnivoice" : "local";
}
