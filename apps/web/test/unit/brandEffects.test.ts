import { describe, expect, it } from "vitest";
import { brandEffectParams } from "../../components/editor/brandEffects";

const brand = { primary: "#2f6bff", secondary: "#0b1222", accent: "#a855f7", background: "#0b1120", surface: "#151d2e", text: "#e8edf7", muted: "#7c8aa5" };
const p = (name: string, kind: string, d: string | number | boolean) => ({ name, kind, default: d });

describe("new graphics effects start in the brand's colours", () => {
  it("maps each effect's colour settings by what they colour", () => {
    expect(brandEffectParams("type-overlay", [p("text", "text", "Key takeaway"), p("color", "color", "#ffffff"), p("accent", "color", "#f59e0b"), p("size", "number", 72)], brand, "Contract signed")).toEqual({ text: "Contract signed", color: "#e8edf7", accent: "#a855f7", size: 72 });
    expect(brandEffectParams("glow-backing", [p("color", "color", "#111827"), p("glowColor", "color", "#8b8fff")], brand)).toEqual({ color: "#151d2e", glowColor: "#2f6bff" });
    expect(brandEffectParams("ribbon", [p("colors", "text", "#3FCEBC,#5F96E7")], brand)).toEqual({ colors: "#2f6bff,#a855f7,#e8edf7" });
    expect(brandEffectParams("color-sweep", [p("colors", "text", "#8b8fff,#22d3ee")], brand)).toEqual({ colors: "#2f6bff,#a855f7,#7c8aa5" });
  });
  it("keeps dark ink and line colours meant for a white board, and defaults without brand colours", () => {
    expect(brandEffectParams("sketch", [p("ink", "color", "#1f2937"), p("accent", "color", "#f59e0b")], brand)).toEqual({ ink: "#1f2937", accent: "#a855f7" });
    expect(brandEffectParams("path-diagram", [p("color", "color", "#1f2937")], brand)).toEqual({ color: "#1f2937" });
    expect(brandEffectParams("glow-backing", [p("glowColor", "color", "#8b8fff")], {})).toEqual({ glowColor: "#8b8fff" });
  });
});
