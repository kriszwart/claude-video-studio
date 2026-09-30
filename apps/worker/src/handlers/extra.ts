import type { Handler } from "../context";
import { proposeProgramCuts, transcribe } from "./program";
import { synthesizeNarration } from "./tts";
import { analyzeMusic } from "./music";
import { importUrl } from "./importUrl";
import { generateMedia, recoverGeneration } from "./generate";
import { ingestCollectionItem } from "./collection";
import { buildSizzle } from "./sizzle";
import { analyzeReference } from "./reference";
import { qualityReview } from "./quality";
import { captureScreenshot } from "./screenshot";
import { composeBrief } from "./compose";
import { writeScript } from "./script";
import { critique } from "./critique";
import { exportOtio } from "./otio";
import { generateMusic } from "./music.gen";

/** Additional handlers registered by later milestones (TTS, transcription, QA, generation…). */
export const extraHandlers: Record<string, Handler> = {
  tts: synthesizeNarration,
  transcribe,
  propose_cuts: proposeProgramCuts,
  analyze_music: analyzeMusic,
  import_url: importUrl,
  generate_media: generateMedia,
  recover_generation: recoverGeneration,
  collection_ingest: ingestCollectionItem,
  build_sizzle: buildSizzle,
  analyze_reference: analyzeReference,
  quality_review: qualityReview,
  screenshot_capture: captureScreenshot,
  compose: composeBrief,
  write_script: writeScript,
  critique,
  export_otio: exportOtio,
  generate_music: generateMusic,
};
