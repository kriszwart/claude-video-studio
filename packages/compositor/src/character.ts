/**
 * Procedural cutout/vector characters (T2). A character is drawn from its persisted
 * reference data (species, palette, proportions) so it looks the same in every scene;
 * poses are GSAP timeline animations on named parts, so frames are repeatable at any seek.
 * Image-mode characters use the owner's own cutouts with the same pose motion.
 */
import type { Character, CharacterLayer } from "@vs/domain";

const f = (n: number) => Number(n.toFixed(2));

export function characterSvg(ch: Character, lid: string, accessory: CharacterLayer["accessory"]): string {
  const p = ch.palette;
  const hs = ch.proportions.head;
  const bs = ch.proportions.body;
  const es = ch.proportions.ears;
  const id = (x: string) => `${lid}-${x}`;
  const headR = 52 * hs;
  const headY = 98 - (hs - 1) * 20;
  const bodyRx = 58 * bs;
  const bodyRy = 62 * bs;
  const bodyY = 178;
  const robot = ch.species === "robot";
  const outline = `stroke="#1f2937" stroke-width="4" stroke-linejoin="round"`;
  const ears = (() => {
    switch (ch.species) {
      case "cat":
        return `<path d="M${f(100 - headR * 0.85)} ${f(headY - headR * 0.35)} L${f(100 - headR * 0.55)} ${f(headY - headR - 30 * es)} L${f(100 - headR * 0.15)} ${f(headY - headR * 0.8)} Z" fill="${p.body}" ${outline}/><path d="M${f(100 + headR * 0.85)} ${f(headY - headR * 0.35)} L${f(100 + headR * 0.55)} ${f(headY - headR - 30 * es)} L${f(100 + headR * 0.15)} ${f(headY - headR * 0.8)} Z" fill="${p.body}" ${outline}/>`;
      case "bear":
        return `<circle cx="${f(100 - headR * 0.7)}" cy="${f(headY - headR * 0.75)}" r="${f(16 * es + 4)}" fill="${p.body}" ${outline}/><circle cx="${f(100 + headR * 0.7)}" cy="${f(headY - headR * 0.75)}" r="${f(16 * es + 4)}" fill="${p.body}" ${outline}/>`;
      case "bird":
        return `<path d="M100 ${f(headY - headR)} q -6 ${f(-26 * es)} 14 ${f(-34 * es)} q -4 ${f(14 * es)} 4 ${f(30 * es)} Z" fill="${p.accent}" ${outline}/>`;
      case "robot":
        return `<line x1="100" y1="${f(headY - headR)}" x2="100" y2="${f(headY - headR - 26 * es)}" stroke="#1f2937" stroke-width="4"/><circle cx="100" cy="${f(headY - headR - 30 * es)}" r="7" fill="${p.accent}" ${outline}/>`;
      default:
        return `<circle cx="${f(100 + headR * 0.5)}" cy="${f(headY - headR * 0.95)}" r="${f(7 * es + 2)}" fill="${p.accent}" ${outline}/>`;
    }
  })();
  const head = robot
    ? `<rect x="${f(100 - headR)}" y="${f(headY - headR * 0.9)}" width="${f(headR * 2)}" height="${f(headR * 1.8)}" rx="16" fill="${p.body}" ${outline}/>`
    : `<circle cx="100" cy="${f(headY)}" r="${f(headR)}" fill="${p.body}" ${outline}/>`;
  const beak = ch.species === "bird" ? `<path d="M92 ${f(headY + 12)} L100 ${f(headY + 26)} L108 ${f(headY + 12)} Z" fill="${p.accent}" ${outline}/>` : "";
  const acc = (() => {
    const top = headY - headR * (robot ? 0.9 : 1);
    switch (accessory) {
      case "hat":
        return `<rect x="70" y="${f(top - 8)}" width="60" height="10" rx="3" fill="#1f2937"/><rect x="80" y="${f(top - 44)}" width="40" height="38" rx="4" fill="#1f2937"/><rect x="80" y="${f(top - 18)}" width="40" height="7" fill="${p.accent}"/>`;
      case "crown":
        return `<path d="M72 ${f(top + 4)} L76 ${f(top - 26)} L88 ${f(top - 10)} L100 ${f(top - 32)} L112 ${f(top - 10)} L124 ${f(top - 26)} L128 ${f(top + 4)} Z" fill="#facc15" ${outline}/>`;
      case "helmet":
        // A dome that sits above the eyes (brim just over the brow line).
        return `<path d="M${f(100 - headR * 0.95)} ${f(top + 4)} C ${f(100 - headR * 0.95)} ${f(top - headR * 0.55)} ${f(100 + headR * 0.95)} ${f(top - headR * 0.55)} ${f(100 + headR * 0.95)} ${f(top + 4)} Z" fill="#94a3b8" ${outline}/><rect x="${f(100 - headR - 6)}" y="${f(top)}" width="${f(headR * 2 + 12)}" height="9" rx="4" fill="#64748b"/>`;
      case "glasses":
        return `<g fill="none" stroke="#111827" stroke-width="4"><circle cx="80" cy="${f(headY - 4)}" r="15"/><circle cx="120" cy="${f(headY - 4)}" r="15"/><line x1="95" y1="${f(headY - 4)}" x2="105" y2="${f(headY - 4)}"/></g>`;
      default:
        return "";
    }
  })();
  const cape = accessory === "cape" ? `<path d="M${f(100 - bodyRx * 0.7)} ${f(bodyY - bodyRy * 0.8)} Q 100 ${f(bodyY - bodyRy)} ${f(100 + bodyRx * 0.7)} ${f(bodyY - bodyRy * 0.8)} L${f(100 + bodyRx + 18)} ${f(bodyY + bodyRy + 6)} L${f(100 - bodyRx - 18)} ${f(bodyY + bodyRy + 6)} Z" fill="${p.accent}" ${outline}/>` : "";
  const arm = (side: "l" | "r") => {
    const x = side === "l" ? 100 - bodyRx + 8 : 100 + bodyRx - 8;
    const w = 18;
    return `<g id="${id(`arm-${side}`)}"><rect x="${f(x - w / 2)}" y="${f(bodyY - bodyRy * 0.55)}" width="${w}" height="${f(52 * bs)}" rx="9" fill="${p.body}" ${outline}/></g>`;
  };
  const leg = (side: "l" | "r") => {
    const x = side === "l" ? 78 : 122;
    return `<g id="${id(`leg-${side}`)}"><rect x="${f(x - 11)}" y="${f(bodyY + bodyRy * 0.6)}" width="22" height="34" rx="10" fill="${p.body}" ${outline}/></g>`;
  };
  return `<svg viewBox="0 0 200 280" width="100%" height="100%" preserveAspectRatio="xMidYMax meet" style="overflow:visible">
<ellipse id="${id("shadow")}" cx="100" cy="272" rx="${f(bodyRx * 0.9)}" ry="8" fill="rgba(0,0,0,.25)"/>
<g id="${id("all")}">${cape}${leg("l")}${leg("r")}${arm("l")}
<g id="${id("body")}"><ellipse cx="100" cy="${bodyY}" rx="${f(bodyRx)}" ry="${f(bodyRy)}" fill="${p.body}" ${outline}/><ellipse cx="100" cy="${f(bodyY + 8)}" rx="${f(bodyRx * 0.62)}" ry="${f(bodyRy * 0.64)}" fill="${p.belly}"/></g>
${arm("r")}
<g id="${id("head")}">${ears}${head}
<g id="${id("eyes")}"><ellipse cx="80" cy="${f(headY - 4)}" rx="11" ry="13" fill="#fff" ${outline}/><ellipse cx="120" cy="${f(headY - 4)}" rx="11" ry="13" fill="#fff" ${outline}/><g id="${id("pupils")}"><circle cx="82" cy="${f(headY - 2)}" r="6" fill="${p.eye}"/><circle cx="122" cy="${f(headY - 2)}" r="6" fill="${p.eye}"/></g></g>
${beak}<path id="${id("mouth")}" d="M86 ${f(headY + 22)} Q100 ${f(headY + 34)} 114 ${f(headY + 22)}" fill="none" stroke="#1f2937" stroke-width="4" stroke-linecap="round"/>
<circle cx="70" cy="${f(headY + 16)}" r="7" fill="${p.accent}" opacity=".35"/><circle cx="130" cy="${f(headY + 16)}" r="7" fill="${p.accent}" opacity=".35"/>
${acc}</g></g></svg>`;
}

/** Pose animation for a character layer over [start, start+dur). */
export function characterTweens(layer: CharacterLayer, ch: Character | undefined, lid: string, start: number, dur: number, k: number, vector: boolean): string[] {
  const t: string[] = [];
  const s = (x: number) => f(x);
  const reps = (period: number) => Math.max(0, Math.floor(dur / period) - 1);
  const all = vector ? `#${lid}-all` : `#${lid}-img`;
  const armR = `#${lid}-arm-r`;
  const armL = `#${lid}-arm-l`;
  const bodyY = 178;
  const shoulderY = bodyY - 62 * (ch?.proportions.body ?? 1) * 0.5;
  const shoulderR = `${s(100 + 58 * (ch?.proportions.body ?? 1) - 8)} ${s(shoulderY)}`;
  const shoulderL = `${s(100 - 58 * (ch?.proportions.body ?? 1) + 8)} ${s(shoulderY)}`;
  const bob = (period: number, amp: number) => t.push(`tl.fromTo("${all}",{y:0},{y:${s(-amp)},duration:${s(period / 2)},yoyo:true,repeat:${reps(period) * 2 + 1},ease:"sine.inOut"},${s(start)});`);
  if (vector) {
    // Blink every ~2.6 s (deterministic).
    for (let b = 1.1; b < dur - 0.2; b += 2.6) t.push(`tl.to("#${lid}-eyes",{scaleY:0.1,svgOrigin:"100 90",duration:0.06,yoyo:true,repeat:1},${s(start + b)});`);
  }
  switch (layer.pose) {
    case "idle":
      bob(1.4, 5 + 4 * k);
      break;
    case "wave":
      bob(1.4, 4);
      if (vector) t.push(`tl.fromTo("${armR}",{rotation:-150,svgOrigin:"${shoulderR}"},{rotation:-110,svgOrigin:"${shoulderR}",duration:0.3,yoyo:true,repeat:${reps(0.6) * 2 + 1},ease:"sine.inOut"},${s(start)});`);
      break;
    case "jump": {
      const period = 0.9;
      t.push(`tl.fromTo("${all}",{y:0},{y:${s(-50 - 20 * k)},duration:${s(period / 2)},yoyo:true,repeat:${reps(period) * 2 + 1},ease:"power1.out"},${s(start)});`);
      if (vector) t.push(`tl.fromTo("#${lid}-shadow",{scaleX:1,svgOrigin:"100 272"},{scaleX:0.6,svgOrigin:"100 272",duration:${s(period / 2)},yoyo:true,repeat:${reps(period) * 2 + 1},ease:"power1.out"},${s(start)});`);
      break;
    }
    case "think":
      bob(2, 3);
      if (vector) {
        t.push(`tl.set("${armR}",{rotation:-135,svgOrigin:"${shoulderR}"},${s(start)});`);
        t.push(`tl.fromTo("#${lid}-head",{rotation:0,svgOrigin:"100 150"},{rotation:8,svgOrigin:"100 150",duration:0.6,ease:"sine.out"},${s(start)});`);
        t.push(`tl.fromTo("#${lid}-pupils",{y:0,x:0},{y:-4,x:3,duration:0.4},${s(start + 0.3)});`);
      }
      break;
    case "celebrate":
      t.push(`tl.fromTo("${all}",{y:0},{y:${s(-24 - 16 * k)},duration:0.3,yoyo:true,repeat:${reps(0.6) * 2 + 1},ease:"sine.out"},${s(start)});`);
      if (vector) {
        t.push(`tl.fromTo("${armR}",{rotation:-160,svgOrigin:"${shoulderR}"},{rotation:-120,svgOrigin:"${shoulderR}",duration:0.3,yoyo:true,repeat:${reps(0.6) * 2 + 1}},${s(start)});`);
        t.push(`tl.fromTo("${armL}",{rotation:160,svgOrigin:"${shoulderL}"},{rotation:120,svgOrigin:"${shoulderL}",duration:0.3,yoyo:true,repeat:${reps(0.6) * 2 + 1}},${s(start)});`);
      }
      break;
    case "point":
      bob(1.6, 3);
      if (vector) t.push(`tl.fromTo("${armR}",{rotation:0,svgOrigin:"${shoulderR}"},{rotation:-95,svgOrigin:"${shoulderR}",duration:0.45,ease:"back.out(2)"},${s(start + 0.2)});`);
      break;
    case "walk":
      if (vector) {
        t.push(`tl.fromTo("#${lid}-leg-l",{rotation:-18,svgOrigin:"78 215"},{rotation:18,svgOrigin:"78 215",duration:0.35,yoyo:true,repeat:${reps(0.7) * 2 + 1},ease:"sine.inOut"},${s(start)});`);
        t.push(`tl.fromTo("#${lid}-leg-r",{rotation:18,svgOrigin:"122 215"},{rotation:-18,svgOrigin:"122 215",duration:0.35,yoyo:true,repeat:${reps(0.7) * 2 + 1},ease:"sine.inOut"},${s(start)});`);
      }
      bob(0.35, 4);
      t.push(`tl.fromTo("#${lid}",{x:${s(-60 - 60 * k)}},{x:${s(60 + 60 * k)},duration:${s(dur)},ease:"none"},${s(start)});`);
      break;
  }
  return t;
}
