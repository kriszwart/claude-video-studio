import type { Background, Layer, ProjectDocument, Scene } from "./document";

/**
 * Deterministic scene regeneration ("new variation"): background, decorative shapes and
 * character pose/accessory are re-rolled from a seed. Text, media, approved facts, locked
 * layers and the character's identity (references, palette, proportions) are untouched.
 * This is a code-driven variation, not AI generation, and is labelled as such.
 */
function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TOKENS = ["brand.primary", "brand.secondary", "brand.accent", "brand.background", "brand.surface"] as const;
const SHAPES = ["circle", "ring", "blob", "grid", "rect"] as const;
const LOOPS = ["pulse", "drift", "spin", "none"] as const;
const POSES = ["idle", "wave", "jump", "think", "celebrate", "point", "walk"] as const;
const ACCESSORIES = ["none", "hat", "glasses", "crown", "helmet", "cape"] as const;

export function varyScene(doc: ProjectDocument, sceneId: string, variant: number): Scene {
  const scene = doc.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error("Scene not found.");
  const r = rng(variant * 7919 + sceneId.length * 131 + [...sceneId].reduce((a, c) => a + c.charCodeAt(0), 0));
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const next: Scene = structuredClone(scene);
  if (next.background.type !== "asset") {
    const from = pick(TOKENS);
    let to = pick(TOKENS);
    if (to === from) to = "brand.background";
    next.background = { type: "gradient", from, to, angle: Math.round(r() * 360) } as Background;
  }
  next.layers = next.layers.map((l): Layer => {
    if (l.kind === "shape") {
      const w = l.box ? l.box.w : 0.3 + r() * 0.4;
      return { ...l, shape: l.shape === "bars" || l.shape === "line" ? l.shape : pick(SHAPES), color: pick(TOKENS.slice(0, 3)), box: l.box ? { ...l.box, x: Math.max(-0.2, Math.min(0.9, l.box.x + (r() - 0.5) * 0.3)), y: Math.max(-0.2, Math.min(0.9, l.box.y + (r() - 0.5) * 0.3)), w, h: l.box.h } : l.box, animation: { ...l.animation, loop: pick(LOOPS) } };
    }
    if (l.kind === "character") {
      const ch = doc.characters.find((c) => c.id === l.characterId);
      return { ...l, pose: pick(POSES), accessory: ch?.locked && l.accessory !== "none" ? l.accessory : pick(ACCESSORIES), facing: r() < 0.5 ? "left" : "right" };
    }
    return l;
  });
  next.motionIntensity = Math.round((0.4 + r() * 0.6) * 100) / 100;
  next.notes = `${scene.notes ? `${scene.notes} · ` : ""}Variation ${variant} (code-generated background/props/pose).`.slice(0, 2000);
  return next;
}
