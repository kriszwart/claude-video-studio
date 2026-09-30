export * from "./types";
export * from "./internetArchive";
export * from "./wikimedia";
export * from "./pexels";
export * from "./pixabay";
import { internetArchive } from "./internetArchive";
import { pexels } from "./pexels";
import { pixabay } from "./pixabay";
import type { FootageAdapter, FootageAdapterDeps, FootageSource } from "./types";
import { wikimedia } from "./wikimedia";

export const FOOTAGE_SOURCES: { id: FootageSource; label: string; needsKey: boolean; keyProvider?: "pexels" | "pixabay"; baseEnv: string }[] = [
  { id: "internet_archive", label: "Internet Archive", needsKey: false, baseEnv: "FOOTAGE_IA_BASE_URL" },
  { id: "wikimedia", label: "Wikimedia Commons", needsKey: false, baseEnv: "FOOTAGE_WIKIMEDIA_BASE_URL" },
  { id: "pexels", label: "Pexels", needsKey: true, keyProvider: "pexels", baseEnv: "FOOTAGE_PEXELS_BASE_URL" },
  { id: "pixabay", label: "Pixabay", needsKey: true, keyProvider: "pixabay", baseEnv: "FOOTAGE_PIXABAY_BASE_URL" },
];

export function footageAdapter(source: FootageSource, deps: FootageAdapterDeps = {}): FootageAdapter {
  const meta = FOOTAGE_SOURCES.find((s) => s.id === source)!;
  // API base overrides exist for the test double only (never in production).
  const baseUrl = deps.baseUrl ?? (process.env.NODE_ENV !== "production" ? process.env[meta.baseEnv] || undefined : undefined);
  const d = { ...deps, baseUrl };
  switch (source) {
    case "internet_archive":
      return internetArchive(d);
    case "wikimedia":
      return wikimedia(d);
    case "pexels":
      return pexels(d);
    case "pixabay":
      return pixabay(d);
  }
}
