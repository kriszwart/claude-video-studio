import type { BrandSnapshot } from "@vs/domain";

/** Fonts bundled with the app (OFL-licensed @fontsource packages), available to preview and render workers. */
export const BUNDLED_FONT_FAMILIES = ["Inter", "Space Grotesk", "DM Serif Display", "Caveat", "Bebas Neue"] as const;

/** Neutral default brand. Clearly generic — replace with a brand kit. */
export const DEFAULT_BRAND: BrandSnapshot = {
  name: "",
  colors: {
    primary: "#4f46e5",
    secondary: "#1e1b4b",
    accent: "#f59e0b",
    background: "#0b0d17",
    surface: "#171a2b",
    text: "#f8fafc",
    muted: "#64748b",
  },
  fonts: { heading: { family: "Space Grotesk", weight: 700 }, body: { family: "Inter", weight: 400 } },
  logoPlacement: "end-card-only",
  captionStyle: "boxed",
  tone: "",
  forbidden: [],
};
