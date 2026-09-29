import type { TemplateDefinitionInput } from "../types";

const inputs: TemplateDefinitionInput["inputs"] = [
  { id: "recording", label: "Recording (video with speech)", kind: "video", required: true, help: "Your original speech is preserved; cuts are separate, reviewable edits." },
  { id: "transcript", label: "Transcript / subtitles (SRT or VTT, optional)", kind: "subtitle", help: "Upload captions you already have, or transcribe with a connected speech-to-text provider." },
  { id: "topic", label: "Name or topic (optional)", kind: "text", maxLength: 60 },
  { id: "visuals", label: "Visual inserts (optional)", kind: "images", maxItems: 6, help: "Shown on phrase-timed beats. Nothing is generated." },
  { id: "logo", label: "Logo (optional)", kind: "image" },
];

const presenterScene = {
  slot: "presenter",
  purpose: "Presenter",
  durationSec: 10,
  layout: "presenter-full",
  background: { type: "color" as const, color: "brand.background" },
  motion: 0.4,
  layers: [],
};

const common = {
  family: "talking-head" as const,
  version: 1,
  engine: "program" as const,
  defaultAspect: "16:9" as const,
  supportedAspects: ["16:9" as const, "9:16" as const, "1:1" as const],
  duration: { minSec: 5, maxSec: 300, defaultSec: 60 },
  inputs,
  scenes: [presenterScene],
  audio: { narration: "none" as const, captions: true, musicGainDb: -18, duckDb: -14, musicLocked: false },
  providers: { required: [], optional: ["transcription" as const, "planner" as const, "segmentation" as const] },
  checklist: [
    "Transcript present (uploaded SRT/VTT or transcribed)",
    "Speech preserved; cuts reviewed and accepted explicitly",
    "Overlays follow the intended utterances after cuts",
  ],
};

/** T5 — Talking-head enhancement: transcript-first captions, sections, reviewable cuts. */
export const talkingHead: TemplateDefinitionInput = {
  ...common,
  id: "talking-head",
  name: "Talking-Head Enhancement",
  description: "Keeps your recording and voice, adds transcript-timed captions and sections, and proposes silence/retake cuts you review one by one with an explicit source-to-output time map.",
  tags: { purpose: ["education", "creator", "update"], generatedMedia: "none" },
  program: { sourceInput: "recording", transcriptInput: "transcript", bRollInput: "visuals", style: "balanced", presenterFraming: "full" },
  profile: { name: "Balanced", pacing: "balanced" },
};

/** P1 — Presenter Motion Intro (T5): phrase-timed labels with readable backing, anchors, restrained zooms. */
export const presenterIntro: TemplateDefinitionInput = {
  ...common,
  id: "presenter-intro",
  preset: "P1",
  name: "Presenter Motion Intro",
  description: "A short presenter intro with labels and logos timed to the exact phrases you name, readable backing cards, positions you set and lock, restrained punch-ins and your own visual inserts.",
  tags: { purpose: ["intro", "creator", "brand"], generatedMedia: "none" },
  duration: { minSec: 5, maxSec: 90, defaultSec: 25 },
  program: { sourceInput: "recording", transcriptInput: "transcript", bRollInput: "visuals", style: "presenter-intro", presenterFraming: "full" },
  profile: { name: "Presenter intro", pacing: "balanced", motionIntensity: 0.5, transition: "fade" },
};

/** P4 — Whiteboard Explainer (T5): hand-drawn illustrations, sequential steps, full-screen + split layouts. */
export const whiteboardExplainer: TemplateDefinitionInput = {
  ...common,
  id: "whiteboard-explainer",
  preset: "P4",
  name: "Whiteboard Explainer",
  description: "Turns an instructional recording into a whiteboard lesson: hand-drawn illustrations of each step, alternating full-screen drawings and a presenter split view, with your voice throughout.",
  tags: { purpose: ["education", "how-to"], generatedMedia: "none" },
  program: { sourceInput: "recording", transcriptInput: "transcript", style: "whiteboard", presenterFraming: "full" },
  profile: { name: "Whiteboard", pacing: "balanced", framing: "split", preferred: ["friendly drawn diagrams", "split-screen explanations"] },
};

/** P5 — Course Lesson (T5): full-screen opening, rounded presenter crop, large concise takeaways. */
export const courseLesson: TemplateDefinitionInput = {
  ...common,
  id: "course-lesson",
  preset: "P5",
  name: "Course Lesson",
  description: "A calm lesson: full-screen opening, then a rounded presenter crop beside large, concise takeaways drawn from what you actually say.",
  tags: { purpose: ["education", "course"], generatedMedia: "none" },
  program: { sourceInput: "recording", transcriptInput: "transcript", style: "course", presenterFraming: "rounded-inset" },
  profile: { name: "Course Lesson", pacing: "calm", typeScale: 1.2, motionIntensity: 0.3, framing: "rounded-inset", textDensity: "sparse" },
};
