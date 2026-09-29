/**
 * Synthetic talking-head fixture (SAMPLE): local TTS speech with deliberate silences, a
 * false start/retake, a filler, and mentions of "Tool A"/"Tool B", over an animated
 * illustrated presenter rendered with HyperFrames. Produces:
 *   fixtures/sample/talking-head-avocado.mp4   (H.264 + AAC, 1280x720)
 *   fixtures/sample/talking-head-avocado.srt   (exact segment timings from construction)
 * It exists to exercise transcript-first editing honestly: the SRT is the ground truth.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderWithHyperFrames } from "@vs/rendering";

const out = join(import.meta.dirname, "..", "fixtures", "sample");
const work = "/tmp/th-fixture";
mkdirSync(join(work, "proj"), { recursive: true });

type Line = { text: string; gapAfter: number; kind?: "retake" | "filler" };
const lines: Line[] = [
  { text: "Hi, I'm Sam.", gapAfter: 0.4 },
  { text: "Today I will show you how to make avocado toast.", gapAfter: 0.3, kind: "retake" },
  { text: "Um, um.", gapAfter: 1.6, kind: "filler" },
  { text: "Today I will show you how to make the best avocado toast.", gapAfter: 0.6 },
  { text: "I plan every recipe in Tool A, and I edit the video in Tool B.", gapAfter: 0.5 },
  { text: "First, toast two slices of sourdough until golden.", gapAfter: 2.2 },
  { text: "Second, mash one ripe avocado with lemon juice and salt.", gapAfter: 0.5 },
  { text: "Third, spread it on the toast and add chili flakes.", gapAfter: 0.5 },
  { text: "That's it. Breakfast in five minutes.", gapAfter: 0.8 },
];

const wavs: string[] = [];
const segs: { start: number; end: number; text: string }[] = [];
let t = 0.5;
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "0.5", join(work, "lead.wav")]);
wavs.push(join(work, "lead.wav"));
lines.forEach((l, i) => {
  const f = join(work, `l${i}.wav`);
  execFileSync("pico2wave", ["-l", "en-US", "-w", f, l.text]);
  const d = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());
  segs.push({ start: t, end: t + d, text: l.text });
  t += d;
  wavs.push(f);
  const g = join(work, `g${i}.wav`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", String(l.gapAfter), g]);
  wavs.push(g);
  t += l.gapAfter;
});
const concat = join(work, "list.txt");
writeFileSync(concat, wavs.map((w) => `file '${w}'`).join("\n"));
// Room tone: very quiet noise under the speech so silence detection has real-world texture.
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", concat, "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=0.004:r=16000:d=${t}`, "-filter_complex", "[0:a]aresample=48000,aformat=channel_layouts=mono[s];[1:a]aresample=48000[n];[s][n]amix=inputs=2:normalize=0,pan=stereo|c0=c0|c1=c0", "-c:a", "pcm_s16le", join(work, "proj", "speech.wav")]);
const total = t;

// Illustrated presenter: head, blinking eyes, mouth that opens during speech segments.
const speaking = JSON.stringify(segs.map((s) => [Number(s.start.toFixed(3)), Number(s.end.toFixed(3))]));
writeFileSync(
  join(work, "proj", "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0}#root{position:relative;width:1280px;height:720px;overflow:hidden;background:linear-gradient(160deg,#f3efe6,#d9e4ec)}
.shelf{position:absolute;left:0;right:0;top:470px;height:18px;background:#b8a58a}
.plant{position:absolute;left:90px;top:330px;width:80px;height:140px;border-radius:40px 40px 10px 10px;background:#5d8f5a}
.frame{position:absolute;right:120px;top:120px;width:170px;height:120px;border:10px solid #8c7a62;background:#f7d9a8}
.body{position:absolute;left:470px;top:430px;width:340px;height:330px;border-radius:170px 170px 0 0;background:#3f6fa0}
.head{position:absolute;left:530px;top:170px;width:220px;height:260px;border-radius:110px;background:#e8b98f}
.hair{position:absolute;left:520px;top:150px;width:240px;height:110px;border-radius:120px 120px 30px 30px;background:#4a3326}
.eye{position:absolute;top:280px;width:22px;height:22px;border-radius:50%;background:#2b2b2b}
.mouth{position:absolute;left:610px;top:365px;width:60px;height:10px;border-radius:0 0 30px 30px;background:#8a3b36}
.tag{position:absolute;left:24px;bottom:18px;font:600 16px Arial;color:#5a6470}
</style><script src="gsap.min.js"></script></head><body>
<div id="root" data-composition-id="main" data-start="0" data-width="1280" data-height="720" data-duration="${total.toFixed(3)}">
<div class="clip" data-start="0" data-duration="${total.toFixed(3)}" style="position:absolute;inset:0">
<div class="shelf"></div><div class="plant"></div><div class="frame"></div><div class="body"></div><div class="head" id="head"></div><div class="hair"></div>
<div class="eye" id="el" style="left:585px"></div><div class="eye" id="er" style="left:673px"></div><div class="mouth" id="mouth"></div>
<div class="tag">SAMPLE · synthetic presenter and TTS voice</div></div></div>
<script>
window.__timelines=window.__timelines||{};var tl=gsap.timeline({paused:true});
var sp=${speaking};
sp.forEach(function(s){var n=Math.max(1,Math.floor((s[1]-s[0])/0.18));for(var i=0;i<n;i++){var at=s[0]+i*0.18;tl.fromTo('#mouth',{height:10},{height:(i%3===0?30:i%3===1?18:24),duration:0.09,ease:'none'},at);tl.to('#mouth',{height:10,duration:0.09,ease:'none'},at+0.09);}});
for(var b=1.7;b<${total.toFixed(2)};b+=3.1){tl.to('#el,#er',{scaleY:0.1,duration:0.06},b);tl.to('#el,#er',{scaleY:1,duration:0.08},b+0.08);}
tl.to('#head',{rotation:2,duration:${(total / 2).toFixed(2)},yoyo:true,repeat:1,ease:'sine.inOut'},0);
tl.set({}, {}, ${total.toFixed(3)});
window.__timelines.main=tl;
</script></body></html>`,
);
execFileSync("cp", [join(import.meta.dirname, "..", "node_modules", ".pnpm", "gsap@3.15.0", "node_modules", "gsap", "dist", "gsap.min.js"), join(work, "proj")]);
await renderWithHyperFrames(join(work, "proj"), join(work, "video.mp4"), { quality: "standard", workers: 2 });
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(work, "video.mp4"), "-i", join(work, "proj", "speech.wav"), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", join(out, "talking-head-avocado.mp4")]);
const stamp = (s: number) => {
  const ms = Math.round(s * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};
writeFileSync(join(out, "talking-head-avocado.srt"), segs.map((s, i) => `${i + 1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${s.text}\n`).join("\n"));
console.log("talking head fixture:", total.toFixed(2), "s,", segs.length, "segments");
process.exit(0);
