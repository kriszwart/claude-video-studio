import type { Handler } from "../context";
import { proposeProgramCuts, transcribe } from "./program";
import { synthesizeNarration } from "./tts";
import { analyzeMusic } from "./music";
import { importUrl } from "./importUrl";
import { generateMedia, recoverGeneration } from "./generate";
import { generateImage } from "./imagegen";
import { matchFootage } from "./matchFootage";
import { ingestCollectionItem } from "./collection";
import { buildSizzle } from "./sizzle";
import { analyzeReference } from "./reference";
import { placeSoundEffects } from "./sfx";
import { planDemo } from "./demoPlan";
import { qualityReview } from "./quality";
import { captureScreenshot } from "./screenshot";
import { composeBrief } from "./compose";
import { writeScript } from "./script";
import { critique } from "./critique";
import { checkFidelity } from "./fidelity";
import { sendLanternist } from "./lanternist";
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
  generate_image: generateImage,
  match_footage: matchFootage,
  recover_generation: recoverGeneration,
  collection_ingest: ingestCollectionItem,
  build_sizzle: buildSizzle,
  analyze_reference: analyzeReference,
  quality_review: qualityReview,
  screenshot_capture: captureScreenshot,
  compose: composeBrief,
  write_script: writeScript,
  critique,
  check_fidelity: checkFidelity,
  send_lanternist: sendLanternist,
  place_sfx: placeSoundEffects,
  plan_demo: planDemo,
  export_otio: exportOtio,
  generate_music: generateMusic,
};
