import { TemplateDefinition } from "./types";
import { productLaunch } from "./builtin/product-launch";
import { brandShowreel, motionReel } from "./builtin/motion-reel";
import { verticalShort } from "./builtin/vertical-short";
import { musicVideo } from "./builtin/music-video";
import { mascotStory } from "./builtin/mascot-story";
import { animeOpening } from "./builtin/anime-opening";
import { productSpecAd } from "./builtin/product-spec-ad";
import { eventSizzle } from "./builtin/event-sizzle";
import { courseLesson, presenterIntro, talkingHead, whiteboardExplainer } from "./builtin/talking-head";

export * from "./types";
export * from "./instantiate";
export * from "./brand";
export * from "./profiles";

export const BUILTIN_TEMPLATES: TemplateDefinition[] = [productLaunch, motionReel, verticalShort, brandShowreel, talkingHead, presenterIntro, whiteboardExplainer, courseLesson, musicVideo, mascotStory, animeOpening, productSpecAd, eventSizzle].map((t) => TemplateDefinition.parse(t));

export function getBuiltinTemplate(id: string, version?: number): TemplateDefinition | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id && (version === undefined || t.version === version));
}
export * from "./fromProject";
export * from "./program";
export * from "./musicVideo";
export * from "./mascot";
export * from "./sizzle";
