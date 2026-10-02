import { describe, expect, it } from "vitest";
import { containRect, demoMotion } from "../src/demo";

const W = 1920, H = 1080, fps = 30;
const screen = containRect({ x: 115, y: 151, w: 1690, h: 864 }, 2880, 1800);
const demo = (steps: { x: number; y: number; zoom: number; atFrames: number; action?: "click" | "move" }[], zoomOut = true) => ({ layerId: "l", zoomOut, steps: steps.map((s) => ({ action: "click" as const, label: "", ...s })) });

describe("screen demo motion", () => {
  it("rests at 1× with no shift, then lands each step centred at its zoom", () => {
    const { frames, clicks } = demoMotion(demo([{ x: 0.4, y: 0.45, zoom: 2, atFrames: 45 }, { x: 0.7, y: 0.6, zoom: 3, atFrames: 100 }]), screen, W, H, fps, 180);
    expect(frames[0]).toMatchObject({ zoom: 1, tx: 0, ty: 0 });
    const f = frames[45]!;
    expect(f.zoom).toBeCloseTo(2, 5);
    // The step's point sits at the centre of the frame (unless clamped at an edge).
    const px = screen.x + 0.4 * screen.w, py = screen.y + 0.45 * screen.h;
    expect(f.tx + f.zoom * px).toBeCloseTo(W / 2, 0);
    expect(f.ty + f.zoom * py).toBeCloseTo(H / 2, 0);
    expect(frames[100]!.zoom).toBeCloseTo(3, 5);
    // The cursor is on the point when the step happens; clicks press a frame later.
    expect(f.cx).toBeCloseTo(px, 3);
    expect(clicks.map((c) => c.frame)).toEqual([46, 101]);
    expect(frames[47]!.press).toBeLessThan(1);
    // Pulled back to the whole screen at the end.
    expect(frames[179]).toMatchObject({ zoom: 1, tx: 0, ty: 0 });
  });

  it("zooms in log space: halfway through a 1×→4× move is 2×", () => {
    const { frames } = demoMotion(demo([{ x: 0.5, y: 0.5, zoom: 4, atFrames: 60 }], false), screen, W, H, fps, 90);
    // The move takes 27 frames (0.9 s) ending at 60; its eased midpoint is frame 46.5.
    const mid = (frames[46]!.zoom + frames[47]!.zoom) / 2;
    expect(mid).toBeGreaterThan(1.8);
    expect(mid).toBeLessThan(2.2);
    // Zoom speed (per doubling) is symmetric: it eases in and out the same way, with no lurch at the end.
    const rate = (i: number) => Math.log(frames[i + 1]!.zoom / frames[i]!.zoom);
    for (let k = 0; k < 12; k++) expect(rate(33 + k)).toBeCloseTo(rate(59 - k), 2);
  });

  it("never shows past the screen's edge when zoomed into a corner", () => {
    const { frames } = demoMotion(demo([{ x: 0.02, y: 0.02, zoom: 2.5, atFrames: 40 }], false), screen, W, H, fps, 60);
    const f = frames[50]!;
    // The view's left/top edges map inside the screen (within the small margin).
    const left = -f.tx / f.zoom, top = -f.ty / f.zoom;
    expect(left).toBeGreaterThanOrEqual(screen.x - (0.03 * W) / f.zoom - 0.5);
    expect(top).toBeGreaterThanOrEqual(screen.y - (0.03 * W) / f.zoom - 0.5);
  });
});
