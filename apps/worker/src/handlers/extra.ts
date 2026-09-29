import type { Handler } from "../context";

/** Additional handlers registered by later milestones (TTS, transcription, QA, generation…). */
export const extraHandlers: Record<string, Handler> = {};
