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
  synthesize(text: string, voiceId: string, out: string, opts?: { rate?: number; signal?: AbortSignal }): Promise<TtsResult>;
}
