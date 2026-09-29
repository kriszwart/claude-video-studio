import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { paletteHistogram, paletteSimilarity, productFidelity } from "../src/fidelity";

const FIX = join(import.meta.dirname, "..", "..", "..", "fixtures", "sample");

describe("product fidelity (colour)", () => {
  it("passes the same product, flags a different colourway and unrelated footage", async () => {
    const teal = join(FIX, "product-bottle-teal.png");
    expect(paletteSimilarity(await paletteHistogram(teal), await paletteHistogram(teal))).toBeGreaterThan(0.99);
    const coral = await productFidelity(join(FIX, "product-bottle-coral.png"), teal);
    expect(coral.flagged).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "fid-"));
    const pattern = join(dir, "pattern.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2,hue=h=120", "-pix_fmt", "yuv420p", pattern]);
    expect((await productFidelity(pattern, teal, 2)).flagged).toBe(true);
    // A slow zoom on the approved photo (a faithful "lifestyle" clip) passes.
    const zoom = join(dir, "zoom.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-loop", "1", "-framerate", "30", "-t", "2", "-i", teal, "-vf", "scale=720:-2,crop=640:640:x='20*t':y='20*t',scale=320:320", "-pix_fmt", "yuv420p", zoom]);
    const ok = await productFidelity(zoom, teal, 2);
    expect(ok.flagged, JSON.stringify(ok)).toBe(false);
  });
});
