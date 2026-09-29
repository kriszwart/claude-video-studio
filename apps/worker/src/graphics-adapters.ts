import type { GraphicsCompiler } from "@vs/rendering";

/** Populated by the Skia/Redraw adapters (section 27). */
export async function loadGraphicsCompiler(_backends: string[]): Promise<GraphicsCompiler | undefined> {
  return undefined;
}
