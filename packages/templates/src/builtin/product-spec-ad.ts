import type { TemplateDefinitionInput } from "../types";

/**
 * P6 — Physical Product Spec Ad (T3 family): approved catalog photos and details, rhythmic
 * music-led edits, a lineup and an end card. The baseline uses only your uploads; optional
 * generated lifestyle shots are separate, budgeted, labelled and replaceable.
 */
export const productSpecAd: TemplateDefinitionInput = {
  id: "product-spec-ad",
  family: "product-launch",
  preset: "P6",
  name: "Physical Product Spec Ad",
  description: "A music-led concept ad from your catalog photos: close-up details, product claims you approve, a lineup and an end card. Optional generated lifestyle shots are budgeted, labelled as generated and never replace your product photos.",
  version: 1,
  tags: { purpose: ["product", "ecommerce", "apparel"], generatedMedia: "optional" },
  defaultAspect: "9:16",
  supportedAspects: ["9:16", "1:1", "16:9"],
  duration: { minSec: 10, maxSec: 45, defaultSec: 20 },
  inputs: [
    { id: "productName", label: "Product name", kind: "text", required: true, maxLength: 50 },
    { id: "catalog", label: "Catalog photos (approved)", kind: "images", required: true, maxItems: 6 },
    { id: "details", label: "Product details / claims (approved)", kind: "facts", maxItems: 4 },
    { id: "cta", label: "Call to action", kind: "text", maxLength: 40 },
    { id: "logo", label: "Logo", kind: "image" },
    { id: "music", label: "Track", kind: "audio" },
    { id: "lifestyle", label: "Add generated lifestyle shots? (optional, paid)", kind: "select", options: ["no", "yes"], default: "no" },
    { id: "lifestyleFootage", label: "Your own lifestyle footage (optional)", kind: "videos", maxItems: 2 },
  ],
  scenes: [
    {
      slot: "hook",
      purpose: "Hook",
      durationSec: 3,
      layout: "fullbleed-media",
      background: { type: "color", color: "brand.background" },
      motion: 0.9,
      layers: [
        { kind: "image", slot: "media", asset: "{{catalog[0]}}", fit: "cover", animation: "fade", kenBurns: true },
        { kind: "text", slot: "headline", role: "headline", text: "{{productName}}", backing: "translucent", animation: "pop", delaySec: 0.3 },
      ],
    },
    {
      slot: "detail",
      purpose: "Detail {{index}}",
      durationSec: 3,
      layout: "hero-split",
      repeatFor: "details",
      transition: { type: "slide", durationFrames: 6 },
      background: { type: "color", color: "brand.surface" },
      motion: 0.85,
      layers: [
        { kind: "image", slot: "media", asset: "{{catalog[i]}}", optional: true, fit: "cover", frame: "rounded", animation: "pop", kenBurns: true },
        { kind: "text", slot: "headline", role: "headline", text: "{{item}}", factFrom: "details[{{index0}}]", animation: "rise", delaySec: 0.2 },
      ],
    },
    {
      slot: "lifestyle",
      purpose: "Lifestyle (generated)",
      durationSec: 3,
      layout: "fullbleed-media",
      when: "lifestyle=yes|lifestyleFootage",
      transition: { type: "fade", durationFrames: 8 },
      background: { type: "color", color: "brand.background" },
      motion: 0.7,
      layers: [
        { kind: "video", slot: "media", asset: "", optional: false, fit: "cover", muted: true, animation: "fade" },
        { kind: "text", slot: "label", role: "label", text: "Concept visual", backing: "translucent", animation: "fade", delaySec: 0.2 },
      ],
      shot: { kind: "video", prompt: "Lifestyle scene featuring {{productName}} exactly as in the reference photo: same shape, colour and logo placement. Natural movement, soft daylight.", continuity: "Preserve garment shape, colour and logos from the reference.", reference: "{{catalog[0]}}", suppliedFrom: "lifestyleFootage" },
    },
    {
      slot: "lineup",
      purpose: "Lineup",
      durationSec: 3,
      layout: "media-grid",
      transition: { type: "zoom", durationFrames: 8 },
      background: { type: "color", color: "brand.background" },
      motion: 0.8,
      layers: [
        { kind: "image", slot: "media", asset: "{{catalog[0]}}", optional: true, fit: "cover", frame: "rounded", animation: "pop" },
        { kind: "image", slot: "media2", asset: "{{catalog[1]}}", optional: true, fit: "cover", frame: "rounded", animation: "pop", delaySec: 0.1 },
        { kind: "image", slot: "media3", asset: "{{catalog[2]}}", optional: true, fit: "cover", frame: "rounded", animation: "pop", delaySec: 0.2 },
        { kind: "image", slot: "media4", asset: "{{catalog[3]}}", optional: true, fit: "cover", frame: "rounded", animation: "pop", delaySec: 0.3 },
      ],
    },
    {
      slot: "endcard",
      purpose: "End card",
      durationSec: 3,
      layout: "end-card",
      transition: { type: "fade", durationFrames: 8 },
      background: { type: "gradient", from: "brand.primary", to: "brand.background", angle: 160 },
      motion: 0.6,
      layers: [
        { kind: "image", slot: "media", asset: "{{logo}}", optional: true, fit: "contain", animation: "pop" },
        { kind: "text", slot: "headline", role: "headline", text: "{{productName}}", animation: "rise" },
        { kind: "text", slot: "cta", role: "cta", text: "{{cta}}", optional: true, animation: "pop", delaySec: 0.3 },
      ],
    },
  ],
  audio: { musicInput: "music", musicGainDb: -2, duckDb: -10, narration: "none", captions: false, musicLocked: false },
  providers: { required: [], optional: ["video-generation"] },
  profile: { name: "Spec ad", pacing: "fast", motionIntensity: 0.85, transition: "slide" },
  checklist: ["Only approved catalog photos and claims", "Generated shots labelled and reviewed for product fidelity", "Music-led pacing"],
};
