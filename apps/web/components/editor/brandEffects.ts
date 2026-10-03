type Param = { name: string; kind: string; default: string | number | boolean };
type BrandColors = Partial<Record<"primary" | "secondary" | "accent" | "background" | "surface" | "text" | "muted", string>>;

/**
 * Starting settings for a newly added graphics effect, in the project's brand colours. Colour
 * settings mean different things per effect (type-overlay's `color` is its text, glow-backing's
 * is its card), so they are mapped by what they colour. Ink and line colours drawn on a white
 * board keep their dark defaults so they stay readable.
 */
/** Skia shader effects whose colours come from the brand. */
const SHADER_FX = new Set(["mesh-gradient", "aurora", "metaballs", "liquid-morph"]);

/** Effects that are backgrounds: they fill the frame, behind the scene's text. */
export const FULL_FRAME_FX = new Set(["mesh-gradient", "aurora", "glass-lens"]);

export function brandEffectParams(component: string, params: Param[], brand: BrandColors, headline = ""): Record<string, string | number | boolean> {
  const pick = (key: keyof BrandColors, fallback: string | number | boolean) => brand[key] ?? fallback;
  const list = (...keys: (keyof BrandColors)[]) => (keys.every((k) => brand[k]) ? keys.map((k) => brand[k]).join(",") : null);
  return Object.fromEntries(
    params.map((p) => {
      if (p.name === "text" && headline) return [p.name, headline];
      if (p.name === "accent") return [p.name, pick("accent", p.default)];
      if (p.name === "glowColor") return [p.name, pick("primary", p.default)];
      if (p.name === "color" && component === "type-overlay") return [p.name, pick("text", p.default)];
      if (p.name === "color" && component === "glow-backing") return [p.name, pick("surface", p.default)];
      if (p.name === "colors" && component === "ribbon") return [p.name, list("primary", "accent", "text") ?? p.default];
      if (p.name === "colors" && component === "color-sweep") return [p.name, list("primary", "accent", "muted") ?? p.default];
      // Shader effects: the brand's colours, with its background as the aurora's base.
      if (p.name === "colors" && SHADER_FX.has(component)) return [p.name, list("primary", "secondary", "accent") ?? list("primary", "accent") ?? p.default];
      if (p.name === "base" && component === "aurora") return [p.name, pick("background", p.default)];
      return [p.name, p.default];
    }),
  );
}
