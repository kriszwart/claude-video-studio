import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { findComponent } from "../src/catalog";
import { palette, SHADER_EFFECTS, shapeAt } from "../src/runtime/sksl";

const require = createRequire(import.meta.url);
type CK = { RuntimeEffect: { Make: (s: string, cb: (e: string) => void) => { getUniformCount(): number; getUniformName(i: number): string; getUniform(i: number): { columns: number; rows: number } } | null } };
const ckPromise: Promise<CK> = require("canvaskit-wasm/bin/canvaskit.js")();

describe("Skia shader effects", () => {
  it("every effect compiles, and its inputs supply every uniform with the right length", async () => {
    const CK = await ckPromise;
    for (const [key, fx] of Object.entries(SHADER_EFFECTS)) {
      const errs: string[] = [];
      const eff = CK.RuntimeEffect.Make(fx.sksl, (e) => errs.push(e));
      expect(eff, `${key}: ${errs.join(" ")}`).not.toBeNull();
      const u = fx.uniforms({ params: {}, seed: 3, t: 1.25, dur: 4, w: 320, h: 180, unit: 0.3 });
      for (let i = 0; i < eff!.getUniformCount(); i++) {
        const name = eff!.getUniformName(i);
        const want = eff!.getUniform(i).columns * eff!.getUniform(i).rows;
        const v = u[name];
        expect(v, `${key}.${name}`).toBeDefined();
        expect(typeof v === "number" ? 1 : v!.length, `${key}.${name} length`).toBe(want);
      }
    }
  });

  it("every effect is listed in the catalog as a Skia component, and the catalog's defaults are accepted", () => {
    for (const key of Object.keys(SHADER_EFFECTS)) {
      const [id, v] = key.split("@");
      const def = findComponent(id!, Number(v));
      expect(def?.backend, key).toBe("skia");
      const params = Object.fromEntries(def!.params.map((p) => [p.name, p.default]));
      const u = SHADER_EFFECTS[key]!.uniforms({ params, seed: 1, t: 0.5, dur: 3, w: 640, h: 360, unit: 0.33 });
      for (const v of Object.values(u)) for (const n of typeof v === "number" ? [v] : v) expect(Number.isFinite(n)).toBe(true);
    }
  });

  it("inputs are a pure function of parameters, seed and time", () => {
    for (const fx of Object.values(SHADER_EFFECTS)) {
      const at = (t: number, seed = 5) => JSON.stringify(fx.uniforms({ params: {}, seed, t, dur: 6, w: 400, h: 300, unit: 0.4 }));
      expect(at(1.5)).toBe(at(1.5));
      // Inside a default transition's 12 frames (0.4 s) too.
      expect(at(0.1)).not.toBe(at(0.3));
    }
    // A different seed moves the seeded parts (orbits, offsets, blobs).
    const mesh = SHADER_EFFECTS["mesh-gradient@1"]!;
    expect(JSON.stringify(mesh.uniforms({ params: {}, seed: 1, t: 1, dur: 3, w: 4, h: 4, unit: 1 }))).not.toBe(JSON.stringify(mesh.uniforms({ params: {}, seed: 2, t: 1, dur: 3, w: 4, h: 4, unit: 1 })));
  });

  it("shape timeline: holds, then melts smoothly into the next shape, and wraps", () => {
    expect(shapeAt([0, 2, 3], 1, 1, 0.5)).toEqual({ a: 0, b: 2, k: 0 });
    expect(shapeAt([0, 2, 3], 1, 1, 1.5).k).toBeCloseTo(0.5, 5);
    expect(shapeAt([0, 2, 3], 1, 1, 2.2)).toMatchObject({ a: 2, b: 3, k: 0 });
    expect(shapeAt([0, 2, 3], 1, 1, 5.5)).toMatchObject({ a: 3, b: 0 });
  });

  it("palette: up to four colours, the last repeated to fill, invalid ones skipped", () => {
    expect(palette("#ff0000,#00ff00")).toEqual([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
    expect(palette("nope").length).toBe(12);
  });
});
