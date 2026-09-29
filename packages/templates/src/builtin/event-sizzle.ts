import type { TemplateDefinitionInput } from "../types";

/**
 * P3 — Event Sizzle Reel (T3 family, multi-source editing). Built from an event collection:
 * search recordings, pick authentic quotes (exact source ranges), and the reel follows the
 * recipe opening energy → insight/outcome → reactions → invitation, ending on the approved
 * logo and next-event details. Quotes are never generated or paraphrased (FR-16, A19).
 */
export const eventSizzle: TemplateDefinitionInput = {
  id: "event-sizzle",
  family: "product-launch",
  preset: "P3",
  name: "Event Sizzle Reel",
  description: "A story from your event recordings: an energetic opening, a real insight, attendee reactions and an invitation to the next event. Every quote plays its original words with clean handles; music ducks under speech.",
  version: 1,
  tags: { purpose: ["event", "community", "recap"], generatedMedia: "none" },
  defaultAspect: "16:9",
  supportedAspects: ["16:9", "9:16", "1:1"],
  duration: { minSec: 10, maxSec: 120, defaultSec: 45 },
  engine: "collection",
  inputs: [
    { id: "eventName", label: "Event name", kind: "text", required: true, maxLength: 60 },
    { id: "invitation", label: "Next-event details (approved)", kind: "facts", maxItems: 3, help: "e.g. “Harbor Summit 2027 · Lisbon · 14–15 May”. Shown exactly as written." },
    { id: "cta", label: "Call to action", kind: "text", maxLength: 50 },
    { id: "logo", label: "Logo (approved)", kind: "image" },
    { id: "music", label: "Music bed", kind: "audio" },
  ],
  scenes: [
    {
      slot: "endcard",
      purpose: "Invitation",
      durationSec: 4,
      layout: "end-card",
      transition: { type: "fade", durationFrames: 10 },
      background: { type: "gradient", from: "brand.primary", to: "brand.background", angle: 160 },
      motion: 0.5,
      layers: [
        { kind: "image", slot: "media", asset: "{{logo}}", optional: true, fit: "contain", animation: "pop" },
        { kind: "text", slot: "headline", role: "headline", text: "{{invitation[0]}}", factFrom: "invitation[0]", optional: true, animation: "rise" },
        { kind: "text", slot: "cta", role: "cta", text: "{{cta}}", optional: true, animation: "pop", delaySec: 0.4 },
        { kind: "text", slot: "label", role: "label", text: "{{invitation[1]}}", factFrom: "invitation[1]", optional: true, animation: "fade", delaySec: 0.6 },
      ],
    },
  ],
  audio: { musicInput: "music", musicGainDb: -6, duckDb: -16, narration: "none", captions: true, musicLocked: false },
  providers: { required: [], optional: ["transcription"] },
  profile: { name: "Event energy", pacing: "balanced", transition: "cut", motionIntensity: 0.5, soundDensity: "moderate" },
  checklist: ["Every quote links to its original recording and time range", "Full words at every cut (clean handles)", "Music lowered under voices", "Ends on the approved logo and next-event details", "No generated or paraphrased testimonials"],
};
