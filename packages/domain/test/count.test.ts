import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate } from "@vs/templates";
import { countAt, countFrames, countIssues, formatCount, parseCount, type CountSpec, type ProjectDocument, type TextLayer } from "../src";

const gbp = { prefix: "£", suffix: "", decimals: 2, thousands: true };
// The total counts down by each real row amount: £3,150 + £2,400 + £1,275 + £850 = £7,675.
const spec: CountSpec = { ...gbp, stops: [{ value: 7675, atFrames: 0 }, { value: 4525, atFrames: 30 }, { value: 2125, atFrames: 60 }, { value: 850, atFrames: 90 }, { value: 0, atFrames: 120 }] };

describe("counting numbers", () => {
  it("formats like the product does, and never shows -0", () => {
    expect(formatCount(7675, gbp)).toBe("£7,675.00");
    expect(formatCount(-0.001, gbp)).toBe("£0.00");
    expect(formatCount(-0.004, gbp)).toBe("£0.00");
    expect(formatCount(1234567, { prefix: "", suffix: " users", decimals: 0, thousands: true })).toBe("1,234,567 users");
    expect(parseCount("£7,675.00")).toEqual({ value: 7675, prefix: "£", suffix: "", decimals: 2, thousands: true });
    expect(parseCount("42%")).toMatchObject({ value: 42, suffix: "%", decimals: 0 });
    expect(parseCount("Plan less")).toBeNull();
  });

  it("every frame shows a value on the way: never above the stop before, never below the next, exact on each stop", () => {
    const frames = countFrames(spec, 140, 30).map((t) => Number(t.replace(/[£,]/g, "")));
    for (let f = 1; f < frames.length; f++) expect(frames[f]!).toBeLessThanOrEqual(frames[f - 1]!);
    for (const s of spec.stops) expect(frames[s.atFrames]).toBe(s.value);
    expect(frames.every((v) => v >= 0 && v <= 7675)).toBe(true);
    expect(countAt(spec, 10, 30)).toBe(7675); // holds until it counts toward the next stop
    expect(countFrames(spec, 140, 30).at(-1)).toBe("£0.00");
  });

  it("accepts values from the approved facts or changes by an approved amount, and flags invented numbers", () => {
    let n = 0;
    const doc = instantiateTemplate(BUILTIN_TEMPLATES.find((t) => t.id === "product-launch")!, {
      title: "T",
      brand: DEFAULT_BRAND,
      inputs: { productName: "Tallyo", promise: "Invoices that chase themselves", problem: "Chasing money", benefits: ["Who owes me: £7,675.00", "Harbour & Finch £3,150", "Lumen £2,400", "Oak £1,275", "Pine £850"], cta: "Sign up free" },
      newId: (p) => `${p}${++n}`,
    }) as ProjectDocument;
    const scene = doc.scenes[0]!;
    const layer = { ...(scene.layers.find((l) => l.kind === "text") as TextLayer), count: spec };
    expect(countIssues(doc, scene.id, layer)).toEqual([]);
    const invented = { ...layer, count: { ...spec, stops: [spec.stops[0]!, { value: 5000, atFrames: 30 }] } };
    expect(countIssues(doc, scene.id, invented)).toEqual([expect.stringContaining("£5,000.00 isn't in your approved facts")]);
  });
});
