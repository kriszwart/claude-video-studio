import { TemplateDefinition } from "./types";
import { productLaunch } from "./builtin/product-launch";
import { brandShowreel, motionReel } from "./builtin/motion-reel";
import { verticalShort } from "./builtin/vertical-short";
import { courseLesson, presenterIntro, talkingHead, whiteboardExplainer } from "./builtin/talking-head";

export * from "./types";
export * from "./instantiate";
export * from "./brand";
export * from "./profiles";

export const BUILTIN_TEMPLATES: TemplateDefinition[] = [productLaunch, motionReel, verticalShort, brandShowreel, talkingHead, presenterIntro, whiteboardExplainer, courseLesson].map((t) => TemplateDefinition.parse(t));

export function getBuiltinTemplate(id: string, version?: number): TemplateDefinition | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id && (version === undefined || t.version === version));
}
export * from "./fromProject";
export * from "./program";
