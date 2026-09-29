/**
 * Reference reel fixture (SAMPLE) for creative-profile analysis: five ~4.6 s shots of the
 * sample screenshots with a slow pan, joined by fades through black, over the sample
 * song at a low level. Ground truth: shot boundaries at 4.6 s intervals, all transitions
 * through black. Produces fixtures/sample/reference-calm-reel.mp4 (640x360).
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const FIX = join(import.meta.dirname, "..", "fixtures", "sample");
const shots = ["tidewave-dashboard.png", "lumen-editor.png", "tidewave-insights.png", "lumen-graph.png", "tidewave-mobile.png"];
const D = 4.6;
const args: string[] = ["-v", "error", "-y"];
shots.forEach((s) => args.push("-loop", "1", "-framerate", "30", "-t", String(D), "-i", join(FIX, s)));
args.push("-i", join(FIX, "music-song.m4a"));
const chains = shots.map((_, i) => `[${i}:v]scale=800:450,crop=720:405:x='16*t':y='9*t',scale=640:360,fps=30,format=yuv420p,fade=t=in:st=0:d=0.3,fade=t=out:st=${(D - 0.3).toFixed(2)}:d=0.3,setsar=1[v${i}]`);
const concat = `${shots.map((_, i) => `[v${i}]`).join("")}concat=n=${shots.length}:v=1:a=0[v]`;
const audio = `[${shots.length}:a]atrim=0:${(D * shots.length).toFixed(2)},volume=-8dB,afade=t=out:st=${(D * shots.length - 1).toFixed(2)}:d=1[a]`;
args.push("-filter_complex", [...chains, concat, audio].join(";"), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", join(FIX, "reference-calm-reel.mp4"));
execFileSync("ffmpeg", args);
console.log("reference reel written");
