import { GraphicsUnavailableError } from "@vs/compositor";
import type { ProjectDocument } from "@vs/domain";
import type { GraphicsCompiler } from "@vs/rendering";
import type { JobContext } from "./context";

/**
 * Capability routing for graphics layers (FR-21). Returns undefined when the document
 * has no graphics layers. When a layer needs a backend this worker cannot run, the
 * render fails with an actionable error — never a blank layer.
 */
export function needsWebGpu(doc: ProjectDocument): boolean {
  return doc.scenes.some((s) => s.layers.some((l) => l.kind === "graphics" && l.backend === "redraw" && !l.hidden));
}

export async function graphicsCompilerFor(doc: ProjectDocument, _ctx: JobContext): Promise<GraphicsCompiler | undefined> {
  const layers = doc.scenes.flatMap((s) => s.layers.filter((l) => l.kind === "graphics" && !l.hidden));
  if (layers.length === 0) return undefined;
  const { loadGraphicsCompiler } = await import("./graphics-adapters");
  const backends = layers.map((l) => (l.kind === "graphics" ? l.backend : "skia"));
  const compiler = await loadGraphicsCompiler(backends);
  if (!compiler) {
    const { graphicsCapabilities } = await import("@vs/graphics");
    const caps = await graphicsCapabilities();
    throw new GraphicsUnavailableError(
      backends.includes("redraw") && !caps.redraw.available ? `Redraw layers can't be rendered on this worker: ${caps.redraw.reason}` : "This worker has no graphics backend configured for the selected components.",
    );
  }
  return compiler;
}
