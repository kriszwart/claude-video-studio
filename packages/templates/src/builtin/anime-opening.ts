import type { TemplateDefinitionInput } from "../types";

const shotLayers = (label?: string) => [
  { kind: "video" as const, slot: "media", asset: "", optional: false, fit: "cover" as const, frame: "none" as const, muted: true, animation: "fade" as const },
  ...(label ? [{ kind: "text" as const, slot: "headline", role: "headline" as const, scale: 0.9, uppercase: true, text: label, optional: true, backing: "translucent" as const, animation: "slide" as const, delaySec: 0.3 }] : []),
];

/**
 * T7 — Anime opening: cold open → character introductions → world montage → rising
 * action → climax → title. Every shot is either supplied footage or generated through a
 * configured, budgeted provider; accepted shots are kept when others fail or are redone.
 */
export const animeOpening: TemplateDefinitionInput = {
  id: "anime-opening",
  family: "anime-opening",
  name: "Anime Opening",
  description: "A shot-listed opening cut to your song: cold open, character introductions, world montage, rising action, climax and title. Supply your own footage, or generate shots within a budget you set — accepted shots are never lost when another shot fails.",
  version: 3,
  tags: { purpose: ["anime", "series", "trailer"], generatedMedia: "optional" },
  defaultAspect: "16:9",
  supportedAspects: ["16:9", "9:16"],
  duration: { minSec: 20, maxSec: 90, defaultSec: 45 },
  engine: "shots",
  inputs: [
    { id: "song", label: "Song", kind: "audio", required: true },
    { id: "excerptStart", label: "Excerpt start (seconds)", kind: "number", default: 0 },
    { id: "excerptEnd", label: "Excerpt end (seconds, 0 = start + 45)", kind: "number", default: 0 },
    { id: "title", label: "Show title", kind: "text", required: true, maxLength: 60 },
    { id: "synopsis", label: "Synopsis", kind: "longtext", required: true, maxLength: 800 },
    { id: "characters", label: "Characters (Name — look/role)", kind: "list", maxItems: 4, required: true },
    { id: "characterImages", label: "Character reference images (same order)", kind: "images", maxItems: 4 },
    { id: "direction", label: "Visual direction", kind: "text", maxLength: 200, default: "cel-shaded anime, dramatic lighting, dynamic camera" },
    { id: "footage", label: "Your own footage (optional, fills shots in order)", kind: "videos", maxItems: 12 },
  ],
  scenes: [
    { slot: "cold-open", purpose: "Cold open", durationSec: 5, layout: "fullbleed-media", background: { type: "color", color: "#05060a" }, motion: 0.6, layers: shotLayers(), shot: { kind: "video", prompt: "{{direction}}. Cold open establishing the mood of: {{synopsis}}", continuity: "Opening shot; no characters' faces yet.", suppliedFrom: "footage" } },
    {
      slot: "character",
      purpose: "Introducing {{item}}",
      durationSec: 3.5,
      layout: "fullbleed-media",
      repeatFor: "characters",
      transition: { type: "wipe", durationFrames: 6 },
      background: { type: "color", color: "#05060a" },
      motion: 0.8,
      layers: shotLayers("{{characterNames[i]}}"),
      shot: { kind: "video", prompt: "{{direction}}. Character introduction: {{item}}. Hero pose, camera push-in.", continuity: "Keep this character's look consistent with the reference.", reference: "{{characterImages[i]}}", suppliedFrom: "footage" },
    },
    { slot: "world", purpose: "World montage", durationSec: 5, layout: "fullbleed-media", transition: { type: "fade", durationFrames: 8 }, background: { type: "color", color: "#05060a" }, motion: 0.7, layers: shotLayers(), shot: { kind: "video", prompt: "{{direction}}. Sweeping montage of the world of: {{synopsis}}", suppliedFrom: "footage" } },
    { slot: "rising", purpose: "Rising action", durationSec: 5, layout: "fullbleed-media", transition: { type: "cut", durationFrames: 0 }, background: { type: "color", color: "#05060a" }, motion: 0.85, layers: shotLayers(), shot: { kind: "video", prompt: "{{direction}}. Rising action, speed lines, the characters run toward the conflict.", suppliedFrom: "footage" } },
    { slot: "climax", purpose: "Climax", durationSec: 5, layout: "fullbleed-media", transition: { type: "zoom", durationFrames: 8 }, background: { type: "color", color: "#05060a" }, motion: 1, layers: shotLayers(), shot: { kind: "video", prompt: "{{direction}}. Climactic clash, impact frames, bright flashes.", suppliedFrom: "footage" } },
    {
      slot: "title",
      purpose: "Title",
      durationSec: 5,
      layout: "title-center",
      transition: { type: "fade", durationFrames: 10 },
      background: { type: "gradient", from: "#05060a", to: "brand.primary", angle: 200 },
      motion: 0.8,
      layers: [
        { kind: "shape", slot: "decor", shape: "ring", color: "brand.accent", animation: "pop", loop: "spin", box: { x: 0.2, y: -0.25, w: 0.6, h: 1.5 } },
        { kind: "text", slot: "headline", role: "headline", text: "{{title}}", scale: 1.3, animation: "type", stagger: true },
      ],
    },
  ],
  audio: { musicInput: "song", musicGainDb: 0, duckDb: -12, narration: "none", captions: false, musicLocked: true },
  musicVideo: { songInput: "song", inInput: "excerptStart", outInput: "excerptEnd" },
  shots: { charactersInput: "characters", characterImagesInput: "characterImages" },
  providers: { required: [], optional: ["video-generation", "image-generation"] },
  profile: { name: "Anime opening", pacing: "fast", motionIntensity: 0.9, transition: "cut" },
  checklist: ["Every shot has supplied or accepted footage", "Cuts fitted to the song's downbeats", "Generated shots reviewed; accepted shots kept", "Spend within the project budget"],
};
