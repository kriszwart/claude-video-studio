import type { TemplateDefinitionInput } from "../types";

/** T6 — Animated music video: section analysis → motif plan → verse/chorus scenes → finale. */
export const musicVideo: TemplateDefinitionInput = {
  id: "music-video",
  family: "music-video",
  name: "Animated Music Video",
  description: "Procedural visuals cut to your song's analysed sections, with a repeated motif that evolves into a finale and accents on the downbeats. Your song is never shortened or replaced beyond the excerpt you choose.",
  version: 1,
  tags: { purpose: ["music", "artist", "lyric"], generatedMedia: "none" },
  defaultAspect: "16:9",
  supportedAspects: ["16:9", "9:16", "1:1"],
  duration: { minSec: 10, maxSec: 180, defaultSec: 60 },
  inputs: [
    { id: "song", label: "Song (your upload)", kind: "audio", required: true },
    { id: "excerptStart", label: "Excerpt start (seconds)", kind: "number", default: 0 },
    { id: "excerptEnd", label: "Excerpt end (seconds, 0 = start + 60)", kind: "number", default: 0 },
    { id: "songTitle", label: "Song title", kind: "text", required: true, maxLength: 60 },
    { id: "artist", label: "Artist", kind: "text", maxLength: 60 },
    { id: "motif", label: "Repeated motif", kind: "select", options: ["ring", "circle", "blob", "bars"], default: "ring" },
    { id: "lyrics", label: "Lyrics (optional, one line per row)", kind: "longtext", help: "Timing is estimated per section until you adjust it; nothing is transcribed automatically." },
  ],
  scenes: [
    {
      slot: "music",
      purpose: "Music",
      durationSec: 10,
      layout: "lyric",
      background: { type: "gradient", from: "brand.background", to: "brand.primary", angle: 140 },
      motion: 0.6,
      layers: [{ kind: "text", slot: "headline", role: "headline", text: "{{songTitle}}", animation: "type" }],
    },
  ],
  audio: { musicInput: "song", musicGainDb: 0, duckDb: -12, narration: "none", captions: false, musicLocked: true },
  musicVideo: { songInput: "song", inInput: "excerptStart", outInput: "excerptEnd", lyricsInput: "lyrics", motifInput: "motif" },
  providers: { required: [], optional: [] },
  profile: { name: "Music video", pacing: "fast", motionIntensity: 0.8, transition: "cut" },
  checklist: ["Excerpt matches the selection", "Cuts land on section markers", "Accents follow the downbeat markers", "Song not shortened beyond the excerpt"],
};
