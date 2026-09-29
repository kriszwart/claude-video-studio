import type { Handler } from "../context";
import { proposeProgramCuts, transcribe } from "./program";
import { synthesizeNarration } from "./tts";
import { analyzeMusic } from "./music";

/** Additional handlers registered by later milestones (TTS, transcription, QA, generation…). */
export const extraHandlers: Record<string, Handler> = {
  tts: synthesizeNarration,
  transcribe,
  propose_cuts: proposeProgramCuts,
  analyze_music: analyzeMusic,
};
