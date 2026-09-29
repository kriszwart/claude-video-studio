import type { ProjectDocument } from "@vs/domain";

const POSES = ["walk", "point", "think", "jump", "wave"] as const;
const ACCESSORIES = ["hat", "glasses", "helmet", "crown", "none"] as const;

function mix(a: string, b: string, t: number): string {
  const ok = (h: string) => /^#[0-9a-f]{6}$/i.test(h);
  if (!ok(a) || !ok(b)) return ok(a) ? a : "#1f2937";
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * T2 escalation: each era keeps the same character reference but changes costume, pose
 * and setting, with the palette and motion climbing toward the transformation.
 */
export function escalateEras(doc: ProjectDocument): ProjectDocument {
  const eras = doc.scenes.filter((s) => s.recipeSlot === "era");
  const c = doc.brand.colors as Record<string, string>;
  eras.forEach((s, i) => {
    const t = eras.length === 1 ? 1 : i / (eras.length - 1);
    s.background = { type: "gradient", from: mix(c.background ?? "#0b1020", c.secondary ?? "#334155", 0.3 + 0.5 * t), to: mix(c.primary ?? "#4f46e5", c.accent ?? "#f59e0b", 0.15 + 0.55 * t), angle: 150 + 60 * t };
    s.motionIntensity = Math.min(1, 0.45 + 0.5 * t);
    for (const l of s.layers) {
      if (l.kind === "character") {
        l.pose = POSES[i % POSES.length]!;
        l.accessory = ACCESSORIES[i % ACCESSORIES.length]!;
        l.facing = i % 2 === 0 ? "right" : "left";
        l.scale = 0.9 + 0.1 * t;
      }
      if (l.kind === "shape" && l.slot !== "decor") l.shape = (["circle", "rect", "ring", "blob"] as const)[i % 4]!;
    }
  });
  return doc;
}
