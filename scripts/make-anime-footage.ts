/**
 * Sample "supplied footage" for the anime-opening template (SAMPLE, CC0): five short
 * procedural clips rendered with HyperFrames — no generation provider involved.
 *   fixtures/sample/anime-*.mp4 (1280×720, 4 s, silent)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderWithHyperFrames } from "@vs/rendering";

const out = join(import.meta.dirname, "..", "fixtures", "sample");
const gsap = join(import.meta.dirname, "..", "node_modules", ".pnpm", "gsap@3.15.0", "node_modules", "gsap", "dist", "gsap.min.js");

const tag = `<div style="position:absolute;left:20px;bottom:14px;font:600 14px Arial;color:rgba(255,255,255,.6)">SAMPLE footage · procedural</div>`;
const clips: Record<string, { css: string; html: string; js: string }> = {
  "anime-night": {
    css: `.bg{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 120%,#3b1d5e,#0a0a1f 60%)}.s{position:absolute;width:3px;height:3px;background:#fff;border-radius:50%}.star{position:absolute;left:1100px;top:80px;width:10px;height:10px;background:#fff;border-radius:50%;box-shadow:0 0 30px 10px #ffd27a}.trail{position:absolute;left:1100px;top:84px;width:0;height:3px;background:linear-gradient(90deg,transparent,#ffd27a);transform-origin:right center}`,
    html: `<div class="bg"></div>${Array.from({ length: 90 }, (_, i) => `<div class="s" style="left:${(i * 137) % 1280}px;top:${(i * 71) % 520}px;opacity:${0.3 + ((i * 13) % 7) / 10}"></div>`).join("")}<div class="trail" id="trail"></div><div class="star" id="star"></div>`,
    js: `tl.to('#star',{x:-700,y:300,duration:3,ease:'power1.in'},0.5);tl.to('#trail',{width:420,x:-700,y:300,duration:3,ease:'power1.in'},0.5);tl.to('.bg',{scale:1.08,duration:4,ease:'none'},0);`,
  },
  "anime-city": {
    css: `.sky{position:absolute;inset:0;background:linear-gradient(#ff8a5b,#ffcf8a 55%,#2b2d42 56%)}.row{position:absolute;bottom:0;left:0;width:2600px;display:flex;align-items:flex-end}.b{margin-right:14px;background:#2b2d42}.row2 .b{background:#3d405b}.sun{position:absolute;left:560px;top:180px;width:160px;height:160px;border-radius:50%;background:#fff3c4}`,
    html: `<div class="sky"></div><div class="sun"></div><div class="row row2" id="far">${Array.from({ length: 40 }, (_, i) => `<div class="b" style="width:${50 + ((i * 37) % 60)}px;height:${160 + ((i * 53) % 180)}px"></div>`).join("")}</div><div class="row" id="near">${Array.from({ length: 30 }, (_, i) => `<div class="b" style="width:${80 + ((i * 29) % 90)}px;height:${220 + ((i * 97) % 260)}px"></div>`).join("")}</div>`,
    js: `tl.to('#far',{x:-240,duration:4,ease:'none'},0);tl.to('#near',{x:-620,duration:4,ease:'none'},0);tl.to('.sun',{y:40,duration:4,ease:'none'},0);`,
  },
  "anime-run": {
    css: `.bg{position:absolute;inset:0;background:#f4f1ea}.line{position:absolute;height:4px;background:#1a1a1a;border-radius:2px}.fig{position:absolute;left:520px;top:250px;width:120px;height:220px;background:#c0392b;border-radius:60px 60px 20px 20px}.head{position:absolute;left:545px;top:170px;width:70px;height:70px;border-radius:50%;background:#1a1a1a}`,
    html: `<div class="bg"></div>${Array.from({ length: 40 }, (_, i) => `<div class="line" style="top:${(i * 23) % 700}px;left:${(i * 311) % 1280}px;width:${120 + ((i * 41) % 260)}px"></div>`).join("")}<div class="fig" id="fig"></div><div class="head" id="head"></div>`,
    js: `tl.fromTo('.line',{x:1400},{x:-1600,duration:0.7,repeat:5,ease:'none',stagger:{each:0.01,from:'random'}},0);tl.to('#fig,#head',{y:-18,duration:0.18,yoyo:true,repeat:21,ease:'sine.inOut'},0);`,
  },
  "anime-clash": {
    css: `.bg{position:absolute;inset:0;background:#0b0b10}.rw{position:absolute;left:640px;top:360px;width:900px;height:10px;transform-origin:left center}.ray{width:100%;height:100%;background:linear-gradient(90deg,#fff,transparent);transform-origin:left center;transform:scaleX(0)}.flash{position:absolute;inset:0;background:#fff;opacity:0}.ring{position:absolute;left:540px;top:260px;width:200px;height:200px;border:12px solid #ffd166;border-radius:50%}`,
    html: `<div class="bg"></div>${Array.from({ length: 24 }, (_, i) => `<div class="rw" style="transform:rotate(${i * 15}deg)"><div class="ray"></div></div>`).join("")}<div class="ring" id="ring"></div><div class="flash" id="flash"></div>`,
    js: `tl.to('.ray',{scaleX:1,duration:0.4,ease:'power4.out',stagger:0.01},1);tl.fromTo('#ring',{scale:0.2,opacity:1},{scale:6,opacity:0,duration:1.2,ease:'power2.out'},1);tl.fromTo('#flash',{opacity:0.9},{opacity:0,duration:0.5},1);tl.to('.bg',{backgroundColor:'#311b3a',duration:2},1.4);`,
  },
  "anime-silhouette": {
    css: `.bg{position:absolute;inset:0;background:linear-gradient(#1b1340,#e8505b 70%,#f9d56e)}.hill{position:absolute;bottom:0;left:-100px;width:1500px;height:220px;background:#120d24;border-radius:50% 50% 0 0}.fig{position:absolute;left:600px;bottom:200px;width:70px;height:160px;background:#120d24;border-radius:30px 30px 6px 6px}.cape{position:absolute;left:560px;bottom:230px;width:70px;height:120px;background:#120d24;transform-origin:right top}`,
    html: `<div class="bg" id="bg"></div><div class="hill"></div><div class="cape" id="cape"></div><div class="fig"></div>`,
    js: `tl.fromTo('#cape',{rotation:10},{rotation:28,duration:0.5,yoyo:true,repeat:7,ease:'sine.inOut'},0);tl.fromTo('#bg',{scale:1.15},{scale:1,duration:4,ease:'power1.out'},0);`,
  },
};

const work = "/tmp/anime-footage";
for (const [name, c] of Object.entries(clips).filter(([n]) => !process.argv[2] || n === process.argv[2])) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("cp", [gsap, join(dir, "gsap.min.js")]);
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}#root{position:relative;width:1280px;height:720px;overflow:hidden}${c.css}</style><script src="gsap.min.js"></script></head><body><div id="root" data-composition-id="main" data-start="0" data-width="1280" data-height="720" data-duration="4"><div class="clip" data-start="0" data-duration="4" style="position:absolute;inset:0">${c.html}${tag}</div></div><script>window.__timelines=window.__timelines||{};var tl=gsap.timeline({paused:true});${c.js}tl.set({}, {}, 4);window.__timelines.main=tl;</script></body></html>`,
  );
  await renderWithHyperFrames(dir, join(out, `${name}.mp4`), { quality: "standard", workers: 2 });
  console.log("wrote", name);
}
process.exit(0);
