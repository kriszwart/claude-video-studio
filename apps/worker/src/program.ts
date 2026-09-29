import type { ProjectDocument } from "@vs/domain";
import type { MixInput, ResolvedAssetFile } from "@vs/rendering";

/**
 * Talking-head source audio: accepted EDL segments are laid end-to-end on the output
 * timeline with short fades at each cut to avoid clicks (FR-13).
 */
export function programMixInputs(doc: ProjectDocument, assets: ReadonlyMap<string, ResolvedAssetFile>): MixInput[] {
  const p = doc.program;
  if (!p) return [];
  const src = assets.get(p.sourceAssetId);
  if (!src?.media.hasAudio) return [];
  const fps = doc.format.fps;
  const fade = Math.max(0, Math.round((p.audioFadeMs / 1000) * fps));
  let cursor = 0;
  const out: MixInput[] = [];
  for (const seg of p.edl.filter((e) => e.review === "accepted")) {
    const frames = Math.round((seg.sourceOutSec - seg.sourceInSec) * fps);
    if (frames <= 0) continue;
    out.push({ id: `src-${seg.id}`, kind: "source", file: src.path, startFrame: cursor, durationFrames: frames, sourceInSec: seg.sourceInSec, gainDb: 0, fadeInFrames: Math.min(fade, 1), fadeOutFrames: Math.min(fade, 1) });
    cursor += frames;
  }
  return out;
}
