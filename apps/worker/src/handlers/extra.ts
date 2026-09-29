import type { Handler } from "../context";
import { synthesizeNarration } from "./tts";

/** Additional handlers registered by later milestones (TTS, transcription, QA, generation…). */
export const extraHandlers: Record<string, Handler> = {
  tts: synthesizeNarration,
};
