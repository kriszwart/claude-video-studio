/**
 * Generates the licensed sample fixtures in fixtures/sample/.
 * Everything here is original, generated content for fictional brands (CC0):
 *  - procedurally synthesised music (scripts/synth.ts),
 *  - UI mock screenshots rendered from local HTML,
 *  - vector logos.
 * Run: pnpm fixtures
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { renderSong, writeWav } from "./synth";

const out = join(import.meta.dirname, "..", "fixtures", "sample");
mkdirSync(out, { recursive: true });

function encodeM4a(wav: string, m4a: string) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-c:a", "aac", "-b:a", "160k", m4a]);
}

// ---- Music -------------------------------------------------------------
const bed = renderSong({
  bpm: 112,
  seed: 7,
  progression: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]],
  sections: [
    { name: "intro", bars: 2, energy: 0.3 },
    { name: "build", bars: 4, energy: 0.6 },
    { name: "main", bars: 8, energy: 0.85 },
    { name: "outro", bars: 3, energy: 0.35 },
  ],
});
writeWav("/tmp/launch-bed.wav", bed.left, bed.right);
encodeM4a("/tmp/launch-bed.wav", join(out, "music-launch-bed.m4a"));
writeFileSync(join(out, "music-launch-bed.json"), JSON.stringify({ bpm: 112, beats: bed.beats, sections: bed.sections }, null, 1));

const song = renderSong({
  bpm: 120,
  seed: 11,
  progression: [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]],
  sections: [
    { name: "intro", bars: 4, energy: 0.25 },
    { name: "verse", bars: 8, energy: 0.45 },
    { name: "chorus", bars: 8, energy: 0.92 },
    { name: "verse", bars: 8, energy: 0.5 },
    { name: "chorus", bars: 8, energy: 0.95 },
    { name: "outro", bars: 4, energy: 0.3 },
  ],
});
writeWav("/tmp/song.wav", song.left, song.right);
encodeM4a("/tmp/song.wav", join(out, "music-song.m4a"));
writeFileSync(join(out, "music-song.json"), JSON.stringify({ bpm: 120, beats: song.beats, sections: song.sections }, null, 1));

// ---- Logos --------------------------------------------------------------
const tidewaveLogo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 140"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs><circle cx="70" cy="70" r="58" fill="url(#g)"/><path d="M28 78c18-18 30-18 42 0s24 18 42 0" stroke="#fff" stroke-width="12" fill="none" stroke-linecap="round"/><text x="148" y="92" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="64" fill="#f8fafc">Tidewave</text></svg>`;
const lumenLogo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 140"><rect x="14" y="14" width="112" height="112" rx="28" fill="#f59e0b"/><path d="M70 36l10 26 26 8-26 8-10 26-10-26-26-8 26-8z" fill="#1c1917"/><text x="148" y="92" font-family="Georgia, serif" font-weight="700" font-size="62" fill="#1c1917">Lumen Notes</text></svg>`;
writeFileSync(join(out, "logo-tidewave.svg"), tidewaveLogo);
writeFileSync(join(out, "logo-lumen.svg"), lumenLogo);

// ---- Screenshots ----------------------------------------------------------
const chromePath = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: chromePath, args: ["--no-sandbox"] });
const page = await browser.newPage({ deviceScaleFactor: 1 });

const shell = (body: string, bg = "#0f172a") => `<!doctype html><html><head><style>
*{box-sizing:border-box;margin:0;font-family:Arial,Helvetica,sans-serif}
body{background:${bg};color:#e2e8f0}
.side{position:absolute;left:0;top:0;bottom:0;width:230px;background:#111827;padding:28px 20px}
.side h2{font-size:22px;color:#22d3ee;margin-bottom:28px}
.side div{padding:10px 12px;border-radius:8px;margin-bottom:6px;color:#94a3b8;font-size:15px}
.side .on{background:#1e293b;color:#f8fafc}
.main{position:absolute;left:230px;right:0;top:0;bottom:0;padding:32px 40px}
h1{font-size:30px;margin-bottom:20px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-bottom:22px}
.card{background:#1e293b;border-radius:14px;padding:20px}
.card b{display:block;font-size:34px;margin-top:8px;color:#f8fafc}
.muted{color:#94a3b8;font-size:14px}
.row{display:flex;align-items:center;gap:12px;background:#1e293b;border-radius:10px;padding:14px 16px;margin-bottom:10px;font-size:16px}
.dot{width:14px;height:14px;border-radius:50%}
.tag{margin-left:auto;font-size:12px;padding:4px 10px;border-radius:99px;background:#334155}
.bar{height:180px;display:flex;align-items:flex-end;gap:14px;padding:16px;background:#1e293b;border-radius:14px}
.bar i{flex:1;background:linear-gradient(#22d3ee,#6366f1);border-radius:6px 6px 0 0}
.sample{position:absolute;right:16px;bottom:10px;font-size:12px;color:#475569}
</style></head><body>${body}<div class="sample">Sample UI · fictional product</div></body></html>`;

const dashboard = shell(`<div class="side"><h2>≋ Tidewave</h2><div class="on">Today</div><div>Planner</div><div>Focus sessions</div><div>Team</div><div>Insights</div></div>
<div class="main"><h1>Good morning, Sam</h1>
<div class="cards"><div class="card"><span class="muted">Planned today</span><b>6 tasks</b></div><div class="card"><span class="muted">Focus time</span><b>3h 20m</b></div><div class="card"><span class="muted">Meetings moved</span><b>2</b></div></div>
<div class="row"><span class="dot" style="background:#22d3ee"></span>Draft Q4 launch brief<span class="tag">9:30 – 11:00</span></div>
<div class="row"><span class="dot" style="background:#a78bfa"></span>Review onboarding flow<span class="tag">11:30 – 12:15</span></div>
<div class="row"><span class="dot" style="background:#f59e0b"></span>Customer interview notes<span class="tag">14:00 – 14:45</span></div>
<div class="row"><span class="dot" style="background:#34d399"></span>Deep work: pricing model<span class="tag">15:00 – 17:00</span></div></div>`);
await page.setViewportSize({ width: 1440, height: 900 });
await page.setContent(dashboard);
await page.screenshot({ path: join(out, "tidewave-dashboard.png") });

const insights = shell(`<div class="side"><h2>≋ Tidewave</h2><div>Today</div><div>Planner</div><div>Focus sessions</div><div>Team</div><div class="on">Insights</div></div>
<div class="main"><h1>Weekly focus</h1><div class="bar">${[40, 65, 55, 80, 72, 30, 20].map((h) => `<i style="height:${h}%"></i>`).join("")}</div>
<p class="muted" style="margin-top:12px">Mon · Tue · Wed · Thu · Fri · Sat · Sun</p>
<div class="cards" style="margin-top:22px"><div class="card"><span class="muted">Longest streak</span><b>4 days</b></div><div class="card"><span class="muted">Blocks protected</span><b>12</b></div><div class="card"><span class="muted">Context switches</span><b>−18%</b></div></div></div>`);
await page.setContent(insights);
await page.screenshot({ path: join(out, "tidewave-insights.png") });

await page.setViewportSize({ width: 430, height: 900 });
await page.setContent(
  shell(`<div style="padding:26px 22px"><h2 style="color:#22d3ee;font-size:22px;margin-bottom:18px">≋ Tidewave</h2><h1 style="font-size:26px">Focus session</h1>
<div style="margin:28px auto;width:240px;height:240px;border-radius:50%;border:14px solid #22d3ee;display:flex;align-items:center;justify-content:center;font-size:48px;font-weight:700">24:18</div>
<div class="row"><span class="dot" style="background:#34d399"></span>Deep work: pricing model</div><div class="row"><span class="dot" style="background:#64748b"></span>Notifications paused</div></div>`),
);
await page.screenshot({ path: join(out, "tidewave-mobile.png") });

const light = (body: string) => shell(body, "#fafaf9").replace("color:#e2e8f0", "color:#1c1917");
await page.setViewportSize({ width: 1440, height: 900 });
await page.setContent(
  light(`<div style="position:absolute;inset:0;display:flex"><div style="width:280px;background:#f5f5f4;padding:28px;border-right:1px solid #e7e5e4"><h2 style="color:#b45309;font-size:22px;margin-bottom:20px">✦ Lumen Notes</h2>${["Inbox", "Research", "Reading list", "Ideas"].map((x, i) => `<div style="padding:10px;border-radius:8px;${i === 1 ? "background:#fde68a" : ""}">${x}</div>`).join("")}</div>
<div style="flex:1;padding:44px 56px;color:#1c1917"><h1 style="font-size:34px;margin-bottom:14px">Field research: coastal wetlands</h1><p style="font-size:18px;line-height:1.6;max-width:760px;color:#44403c">Linked to <u>Tide tables</u>, <u>Survey plan</u> and 3 more notes. Highlights sync from your reading list automatically.</p>
<div style="margin-top:26px;display:grid;grid-template-columns:1fr 1fr;gap:18px;max-width:820px">${["Backlinks · 5", "Highlights · 12", "Tasks · 3", "Sources · 7"].map((x) => `<div style="background:#fff;border:1px solid #e7e5e4;border-radius:14px;padding:22px;font-size:18px">${x}</div>`).join("")}</div></div></div>`),
);
await page.screenshot({ path: join(out, "lumen-editor.png") });
await page.setContent(
  light(`<div style="padding:60px;color:#1c1917"><h1 style="font-size:34px;margin-bottom:24px">Graph view</h1><svg width="1200" height="620">${Array.from({ length: 22 }, (_, i) => {
    const x = 120 + ((i * 263) % 1000);
    const y = 60 + ((i * 157) % 520);
    const x2 = 120 + (((i + 5) * 263) % 1000);
    const y2 = 60 + (((i + 5) * 157) % 520);
    return `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" stroke="#d6d3d1" stroke-width="2"/><circle cx="${x}" cy="${y}" r="${10 + (i % 4) * 5}" fill="${i % 3 ? "#f59e0b" : "#1c1917"}"/>`;
  }).join("")}</svg></div>`),
);
await page.screenshot({ path: join(out, "lumen-graph.png") });

// Rasterise logos too (PNG with alpha) for players that prefer bitmaps.
for (const [name, svg] of [["logo-tidewave", tidewaveLogo], ["logo-lumen", lumenLogo]] as const) {
  await page.setViewportSize({ width: 960, height: 280 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", '<svg width="960" height="280" ')}</body></html>`);
  await page.screenshot({ path: join(out, `${name}.png`), omitBackground: true });
}
await browser.close();

writeFileSync(
  join(out, "README.md"),
  `# Sample fixtures (generated)

All files in this folder are **sample data for fictional products** ("Tidewave", "Lumen Notes"),
generated by \`scripts/make-fixtures.ts\` and dedicated to the public domain (CC0).

- \`music-*.m4a\`: original procedurally synthesised music (\`scripts/synth.ts\`). The \`.json\`
  sidecars contain the exact generated beat and section times (ground truth for tests).
- \`*.png\` screenshots: rendered from local HTML mock-ups; every image is labelled "Sample UI".
- \`logo-*.svg/png\`: simple vector marks drawn for these fictional brands.

They are safe to commit and to use in public template previews. They are not real products.
`,
);
console.log("fixtures written to", out);
