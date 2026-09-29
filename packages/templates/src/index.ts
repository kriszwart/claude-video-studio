import { TemplateDefinition } from "./types";
import { productLaunch } from "./builtin/product-launch";

export * from "./types";
export * from "./instantiate";
export * from "./brand";

export const BUILTIN_TEMPLATES: TemplateDefinition[] = [productLaunch].map((t) => TemplateDefinition.parse(t));

export function getBuiltinTemplate(id: string, version?: number): TemplateDefinition | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id && (version === undefined || t.version === version));
}
export * from "./fromProject";
