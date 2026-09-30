"use client";
import { useState } from "react";

/** Families with a frame rendered by the real pipeline, shipped in public/template-posters. */
const POSTERS = new Set(["product-launch", "motion-reel", "vertical-short", "talking-head", "mascot-story", "music-video", "anime-opening"]);

export function TemplatePoster({ family, name, preset }: { family: string; name: string; preset?: boolean }) {
  const [failed, setFailed] = useState(false);
  const src = POSTERS.has(family) && !failed ? `/template-posters/${family}.jpg` : null;
  return (
    <div className="relative aspect-video overflow-hidden border-b border-line bg-[radial-gradient(circle_at_30%_20%,color-mix(in_srgb,var(--color-accent)_35%,transparent),transparent_60%),linear-gradient(135deg,#17151f,#0b0b10)]">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={`A frame rendered with ${name}`} onError={() => setFailed(true)} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" loading="lazy" />
      ) : (
        <div className="flex h-full items-center justify-center px-6 text-center text-lg font-semibold tracking-tight text-white/80">{name}</div>
      )}
      {src && preset && <span className="absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1 py-px text-[9px] text-white/80" title={`A frame from the ${family.replace(/-/g, " ")} template this preset builds on`}>{family.replace(/-/g, " ")} base</span>}
    </div>
  );
}
