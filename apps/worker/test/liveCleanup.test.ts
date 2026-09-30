import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const prev = process.env.DATA_DIR;
const root = mkdtempSync(join(tmpdir(), "live-prune-"));
process.env.DATA_DIR = root;
afterAll(() => {
  process.env.DATA_DIR = prev;
});

describe("live preview cache pruning", () => {
  it("drops stale bundles, old mixes and abandoned temp dirs; keeps fresh ones", async () => {
    const { pruneLiveBundles } = await import("../src/handlers/cleanup");
    const live = join(root, "live");
    const now = Date.now();
    const mk = (name: string, ageHours: number) => {
      const p = join(live, name);
      mkdirSync(join(p, "bundle"), { recursive: true });
      writeFileSync(join(p, "bundle", "index.html"), "x");
      const t = new Date(now - ageHours * 3600_000);
      utimesSync(p, t, t);
      return p;
    };
    const fresh = mk("aaaaaaaaaaaaaaaaaaaaaaaa", 1);
    const stale = mk("bbbbbbbbbbbbbbbbbbbbbbbb", 72);
    const tmpOld = mk("cccccccccccccccccccccccc.tmp-job_1", 2);
    const tmpNew = mk("dddddddddddddddddddddddd.tmp-job_2", 0.1);
    mkdirSync(join(live, "mix"), { recursive: true });
    writeFileSync(join(live, "mix", "old.wav"), "x");
    writeFileSync(join(live, "mix", "new.wav"), "x");
    const old = new Date(now - 8 * 24 * 3600_000);
    utimesSync(join(live, "mix", "old.wav"), old, old);
    const n = await pruneLiveBundles(now);
    expect(n).toBe(3);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(tmpOld)).toBe(false);
    expect(existsSync(tmpNew)).toBe(true);
    expect(existsSync(join(live, "mix", "old.wav"))).toBe(false);
    expect(existsSync(join(live, "mix", "new.wav"))).toBe(true);
  });
});
