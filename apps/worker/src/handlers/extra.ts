import type { Handler } from "../context";
import { proposeProgramCuts, transcribe } from "./program";
import { synthesizeNarration } from "./tts";
import { analyzeMusic } from "./music";
import { importUrl } from "./importUrl";
import { generateMedia, recoverGeneration } from "./generate";

/** Additional handlers registered by later milestones (TTS, transcription, QA, generation…). */
export const extraHandlers: Record<string, Handler> = {
  tts: synthesizeNarration,
  transcribe,
  propose_cuts: proposeProgramCuts,
  analyze_music: analyzeMusic,
  import_url: importUrl,
  generate_media: generateMedia,
  recover_generation: recoverGeneration,
};
