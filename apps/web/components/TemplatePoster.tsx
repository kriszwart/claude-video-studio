"use client";

export interface Poster {
  url: string;
  /** "own": the template's own image; "family": a frame rendered by the template it builds on. */
  kind: "own" | "family";
}

/** A template's thumbnail (resolved by the server), or a gradient card with its name. */
export function TemplatePoster({ poster, family, name }: { poster: Poster | null | undefined; family: string; name: string }) {
  return (
    <div className="relative aspect-video overflow-hidden border-b border-line bg-[radial-gradient(circle_at_30%_20%,color-mix(in_srgb,var(--color-accent)_35%,transparent),transparent_60%),linear-gradient(135deg,#17151f,#0b0b10)]">
      {poster ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={poster.url} alt={`Example for ${name}`} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" loading="lazy" />
      ) : (
        <div className="flex h-full items-center justify-center px-6 text-center text-lg font-semibold tracking-tight text-white/80">{name}</div>
      )}
      {poster?.kind === "family" && (
        <span className="absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1 py-px text-[9px] text-white/80" title={`A frame from the ${family.replace(/-/g, " ")} template this one builds on`}>
          {family.replace(/-/g, " ")} base
        </span>
      )}
    </div>
  );
}
