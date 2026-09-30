export interface Voice {
  id: string;
  label: string;
  language: string;
}

export interface TtsResult {
  /** Path of the synthesised WAV file. */
  file: string;
  provider: string;
  voiceId: string;
  /** Measured duration from the audio itself, never estimated. */
  durationSec?: number;
}

export interface TtsProvider {
  id: string;
  /** "local" providers consume compute but are not billed; they are not labelled free of cost. */
  kind: "local" | "hosted";
  voices(): Promise<Voice[]>;
  /** Extra cache-key material for a voice (e.g. a designed voice's description), so edits re-synthesise. */
  cacheSalt?(voiceId: string): string;
  synthesize(text: string, voiceId: string, out: string, opts?: SynthesizeOptions): Promise<TtsResult>;
}

export interface SynthesizeOptions {
  /** Speech-rate multiplier (overall rate × the scene's pace). */
  rate?: number;
  /** Delivery direction beyond pace; providers use what they support (see DIRECTION_SUPPORT). */
  energy?: "calm" | "neutral" | "lively";
  note?: string;
  signal?: AbortSignal;
}

/** Spoken-instruction phrasing for providers that take free-text delivery instructions. */
export function directionInstructions(opts: Pick<SynthesizeOptions, "energy" | "note">): string {
  const energy = opts.energy === "calm" ? "Calm, measured delivery." : opts.energy === "lively" ? "Lively, upbeat delivery." : "";
  return [energy, opts.note?.trim() ?? ""].filter(Boolean).join(" ");
}
