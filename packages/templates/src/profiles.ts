import type { CreativeProfileSnapshot } from "@vs/domain";

/**
 * Built-in creative profile presets (editing taste, not identity or structure).
 * "Fast Social" is the shared T4/T5 treatment from section 21 — a style setting, not an engine.
 */
export const PROFILE_PRESETS: Record<string, CreativeProfileSnapshot> = {
  balanced: { name: "Balanced", pacing: "balanced", typeScale: 1, transition: "fade", motionIntensity: 0.6, soundDensity: "moderate", textDensity: "balanced", framing: "full", preferred: [], avoided: [] },
  "fast-social": {
    name: "Fast Social",
    pacing: "fast",
    typeScale: 1.15,
    transition: "zoom",
    motionIntensity: 0.95,
    soundDensity: "rich",
    textDensity: "sparse",
    framing: "full",
    preferred: ["bold burned-in captions", "punch-ins on key phrases", "visual change every 2–3 s"],
    avoided: ["long static shots", "small text"],
  },
  "calm-technical": {
    name: "Calm Technical",
    pacing: "calm",
    typeScale: 1.2,
    transition: "fade",
    motionIntensity: 0.35,
    soundDensity: "minimal",
    textDensity: "balanced",
    framing: "split",
    preferred: ["longer explanation shots", "split-screen explanations", "large lesson text"],
    avoided: ["whoosh effects", "rapid cuts"],
  },
  "course-lesson": {
    name: "Course Lesson",
    pacing: "calm",
    typeScale: 1.3,
    transition: "fade",
    motionIntensity: 0.3,
    soundDensity: "minimal",
    textDensity: "sparse",
    framing: "rounded-inset",
    preferred: ["full-screen opening", "rounded presenter crop", "three large takeaways"],
    avoided: ["busy B-roll"],
  },
};
