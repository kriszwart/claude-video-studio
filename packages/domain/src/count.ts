import type { CountSpec, ProjectDocument, TextLayer } from "./document";

/**
 * Counting numbers (pure): what a counter shows on every frame, how it is written, and whether
 * its values come from the owner's approved facts. Between two stops the value eases from one to
 * the next over at most half a second (and half the gap, so each value holds), ending exactly on the stop; it is rounded for display, so
 * it never passes a stop and never reads "-0".
 */

export function formatCount(v: number, spec: Pick<CountSpec, "prefix" | "suffix" | "decimals" | "thousands">): string {
  const r = Number(v.toFixed(spec.decimals));
  const x = Object.is(r, -0) || Math.abs(r) < 0.5 * 10 ** -spec.decimals ? 0 : r;
  const abs = Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: spec.decimals, maximumFractionDigits: spec.decimals, useGrouping: spec.thousands });
  return `${x < 0 ? "−" : ""}${spec.prefix}${abs}${spec.suffix}`;
}

/** Read a number written in text ("£7,675.00", "42%", "3.5x") into a counter format. */
export function parseCount(text: string): { value: number; prefix: string; suffix: string; decimals: number; thousands: boolean } | null {
  const m = /^(\D*?)(-?\d{1,3}(?:,\d{3})+|-?\d+)(?:\.(\d+))?(\D*)$/.exec(text.trim());
  if (!m) return null;
  const int = m[2]!.replace(/,/g, "");
  const dec = m[3] ?? "";
  return { value: Number(`${int}${dec ? `.${dec}` : ""}`), prefix: m[1]!, suffix: m[4]!, decimals: Math.min(2, dec.length), thousands: m[2]!.includes(",") || Math.abs(Number(int)) >= 10000 };
}

const easeOut = (u: number) => 1 - (1 - u) ** 3;

/** The value shown at a scene-local frame. */
export function countAt(spec: CountSpec, frame: number, fps: number): number {
  const stops = [...spec.stops].sort((a, b) => a.atFrames - b.atFrames);
  if (frame <= stops[0]!.atFrames) return stops[0]!.value;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!, b = stops[i]!;
    if (frame >= b.atFrames) continue;
    // Count during at most half the gap (and half a second), so each value holds long enough to read.
    const len = Math.max(1, Math.min(Math.round(fps * 0.5), Math.round((b.atFrames - a.atFrames) / 2)));
    const from = b.atFrames - len;
    if (frame <= from) return a.value;
    return a.value + (b.value - a.value) * easeOut((frame - from) / len);
  }
  return stops.at(-1)!.value;
}

/** The text on every frame of the scene (for the compositor). */
export function countFrames(spec: CountSpec, durationFrames: number, fps: number): string[] {
  return Array.from({ length: durationFrames }, (_, f) => formatCount(countAt(spec, f, fps), spec));
}

/** Numbers written in the owner's approved facts and brief (commas and currency stripped). */
export function approvedNumbers(doc: ProjectDocument): Set<number> {
  const texts = [...doc.brief.approvedFacts.map((f) => f.text), doc.brief.promise, ...doc.brief.benefits];
  const out = new Set<number>();
  for (const t of texts) for (const m of t.matchAll(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g)) out.add(Number(m[0].replace(/,/g, "")));
  return out;
}

/**
 * Problems with a counter: stops out of order or outside the scene, and values that neither appear
 * in the approved facts nor differ from the previous stop by an approved amount (e.g. a total
 * counting down by each row's real amount is fine; an invented number is not).
 */
export function countIssues(doc: ProjectDocument, sceneId: string, layer: TextLayer): string[] {
  const spec = layer.count;
  if (!spec) return [];
  const scene = doc.scenes.find((s) => s.id === sceneId);
  const out: string[] = [];
  const stops = spec.stops;
  for (let i = 1; i < stops.length; i++) if (stops[i]!.atFrames <= stops[i - 1]!.atFrames) out.push(`Stop ${i + 1} must come after stop ${i}.`);
  if (scene && stops.some((s) => s.atFrames >= scene.durationFrames)) out.push("Every stop must be reached within the scene.");
  const ok = approvedNumbers(doc);
  const near = (v: number) => [...ok].some((n) => Math.abs(n - v) < 1e-6);
  stops.forEach((s, i) => {
    if (s.value === 0 || near(s.value)) return;
    if (i > 0 && near(Math.abs(s.value - stops[i - 1]!.value))) return;
    out.push(`${formatCount(s.value, spec)} isn't in your approved facts (neither the number nor the change from the stop before). Add the fact, or use real numbers.`);
  });
  return out;
}
