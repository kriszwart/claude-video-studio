import { join } from "node:path";
import { dataDir } from "@vs/db";
import { createGraphicsCompiler, graphicsCapabilities } from "@vs/graphics";
import type { GraphicsCompiler } from "@vs/rendering";

/** Build the Skia/Redraw compiler this worker can actually run (FR-21 capability routing). */
export async function loadGraphicsCompiler(backends: string[]): Promise<GraphicsCompiler | undefined> {
  const need = new Set(backends.filter((b): b is "skia" | "redraw" | "three" => b === "skia" || b === "redraw" || b === "three"));
  const caps = await graphicsCapabilities();
  if (need.has("redraw") && !caps.redraw.available) return undefined;
  return (await createGraphicsCompiler(need, join(dataDir(), "graphics-cache"))) as unknown as GraphicsCompiler;
}
