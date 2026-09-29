/**
 * Event-collection fixtures (SAMPLE): four short "recordings" from a fictional conference
 * ("Harbor Summit") — an opening welcome, a talk excerpt, two attendee reactions and a closing
 * invitation — spoken by the local TTS voice (pitch-shifted per speaker) over simple drawn
 * stage/hallway scenes. Every file is labelled SAMPLE and no real person appears. Produces:
 *   fixtures/sample/event/<name>.mp4 + <name>.srt  (SRT = exact construction timings)
 *   fixtures/sample/event/session-notes-audio.m4a    (audio only, deliberately without a
 *                                                     transcript: exercises "needs transcript")
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = join(import.meta.dirname, "..", "fixtures", "sample", "event");
const work = "/tmp/event-fixture";
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });

type Line = { text: string; gapAfter: number };
interface Recording {
  name: string;
  label: string;
  lang: "en-US" | "en-GB";
  /** Resample factor: < 1 lowers the voice (and slows it slightly). */
  pitch: number;
  bg: string;
  accent: string;
  lines: Line[];
}

const recordings: Recording[] = [
  {
    name: "opening-welcome",
    label: "Main stage · opening",
    lang: "en-US",
    pitch: 1,
    bg: "0x1d2a44",
    accent: "0xf59e0b",
    lines: [
      { text: "Good morning everyone, and welcome to Harbor Summit.", gapAfter: 0.7 },
      { text: "We have three hundred builders in this room today.", gapAfter: 0.6 },
      { text: "Let's make it a big one!", gapAfter: 0.9 },
      { text: "Please find your seats, the first session starts in five minutes.", gapAfter: 0.8 },
    ],
  },
  {
    name: "talk-migration-lessons",
    label: "Room B · migration talk",
    lang: "en-GB",
    pitch: 0.86,
    bg: "0x243b2f",
    accent: "0x34d399",
    lines: [
      { text: "The biggest lesson from our migration was simple.", gapAfter: 0.6 },
      { text: "Measure first, then change one thing at a time.", gapAfter: 0.7 },
      { text: "We cut our build time from forty minutes to six.", gapAfter: 0.8 },
      { text: "And the team shipped twice as often.", gapAfter: 0.9 },
      { text: "Um, so, yeah.", gapAfter: 1.0 },
    ],
  },
  {
    name: "attendee-maya",
    label: "Hallway · attendee",
    lang: "en-US",
    pitch: 1.08,
    bg: "0x3b2a3f",
    accent: "0xf472b6",
    lines: [
      { text: "Honestly, this was the best workshop I have been to all year.", gapAfter: 0.7 },
      { text: "I learned how to set up tracing in one afternoon.", gapAfter: 0.9 },
    ],
  },
  {
    name: "attendee-leo",
    label: "Hallway · attendee",
    lang: "en-GB",
    pitch: 0.8,
    bg: "0x2f3440",
    accent: "0x60a5fa",
    lines: [
      { text: "The hallway conversations were incredible.", gapAfter: 0.6 },
      { text: "I met three people who are solving the same problem as me.", gapAfter: 0.9 },
    ],
  },
  {
    name: "closing-invitation",
    label: "Main stage · closing",
    lang: "en-US",
    pitch: 1,
    bg: "0x1d2a44",
    accent: "0xf59e0b",
    lines: [
      { text: "Thank you for being here.", gapAfter: 0.6 },
      { text: "Next year we are going bigger.", gapAfter: 0.5 },
      { text: "Join us in Lisbon, and register early for the community ticket.", gapAfter: 0.9 },
    ],
  },
];

const probe = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());
const silence = (f: string, d: number) => execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", d.toFixed(3), "-c:a", "pcm_s16le", f]);
const stamp = (s: number) => {
  const ms = Math.round(s * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

for (const r of recordings) {
  const wavs: string[] = [];
  const segs: { start: number; end: number; text: string }[] = [];
  let t = 0.6;
  silence(join(work, `${r.name}-lead.wav`), t);
  wavs.push(join(work, `${r.name}-lead.wav`));
  r.lines.forEach((l, i) => {
    const raw = join(work, `${r.name}-${i}-raw.wav`);
    const f = join(work, `${r.name}-${i}.wav`);
    execFileSync("pico2wave", ["-l", r.lang, "-w", raw, l.text]);
    // Different "speakers": resample-based pitch shift, back to 16 kHz mono.
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", raw, "-af", `asetrate=${Math.round(16000 * r.pitch)},aresample=16000`, "-ac", "1", "-c:a", "pcm_s16le", f]);
    const d = probe(f);
    segs.push({ start: t, end: t + d, text: l.text });
    t += d;
    wavs.push(f);
    const g = join(work, `${r.name}-g${i}.wav`);
    silence(g, l.gapAfter);
    wavs.push(g);
    t += l.gapAfter;
  });
  const list = join(work, `${r.name}.txt`);
  writeFileSync(list, wavs.map((w) => `file '${w}'`).join("\n"));
  const speech = join(work, `${r.name}.wav`);
  // Room tone + a little reverb-free crowd hiss so cut detection works on realistic texture.
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=0.005:r=16000:d=${t}`, "-filter_complex", "[0:a]aresample=48000,aformat=channel_layouts=mono[s];[1:a]aresample=48000[n];[s][n]amix=inputs=2:normalize=0,pan=stereo|c0=c0|c1=c0", "-c:a", "pcm_s16le", speech]);

  // Drawn scene: backdrop, a speaker silhouette whose "mouth" bar pulses during speech, label.
  const talking = segs.map((s) => `between(t,${s.start.toFixed(3)},${s.end.toFixed(3)})`).join("+");
  const vf = [
    `drawbox=x=0:y=250:w=640:h=110:color=${r.accent}@0.18:t=fill`,
    `drawbox=x=250:y=120:w=140:h=240:color=0x0b1020@0.85:t=fill`,
    `drawbox=x=280:y=60:w=80:h=80:color=0xe8b98f:t=fill`,
    `drawbox=x=305:y=115:w=30:h=6:color=0x8a3b36:t=fill:enable='${talking}*lt(mod(t\\,0.2)\\,0.1)'`,
    `drawtext=fontfile=${FONT}:text='${r.label}':x=20:y=20:fontsize=18:fontcolor=white`,
    `drawtext=fontfile=${FONT}:text='SAMPLE · Harbor Summit (fictional) · synthetic voice':x=20:y=330:fontsize=12:fontcolor=white@0.8`,
  ].join(",");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${r.bg}:s=640x360:r=30:d=${t.toFixed(3)}`, "-i", speech, "-vf", vf, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart", join(out, `${r.name}.mp4`)]);
  writeFileSync(join(out, `${r.name}.srt`), segs.map((s, i) => `${i + 1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${s.text}\n`).join("\n"));
  console.log(r.name, t.toFixed(2), "s,", segs.length, "segments");
}

// Audio-only session notes with no transcript: stays "needs transcript" unless speech-to-text is configured.
const notes = join(work, "notes-raw.wav");
execFileSync("pico2wave", ["-l", "en-US", "-w", notes, "These are the session notes for the afternoon track. Room C is moving to the upstairs hall."]);
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", notes, "-c:a", "aac", "-b:a", "64k", join(out, "session-notes-audio.m4a")]);
process.exit(0);
