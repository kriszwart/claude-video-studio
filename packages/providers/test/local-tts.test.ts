import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findBinary } from "../src";

const env = { PATH: process.env.PATH, ESPEAK_NG_BIN: process.env.ESPEAK_NG_BIN };
afterEach(() => {
  process.env.PATH = env.PATH;
  if (env.ESPEAK_NG_BIN === undefined) delete process.env.ESPEAK_NG_BIN;
  else process.env.ESPEAK_NG_BIN = env.ESPEAK_NG_BIN;
});

describe("local TTS binary lookup", () => {
  it("finds espeak-ng on PATH (e.g. Homebrew's /opt/homebrew/bin), not only in /usr/bin", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "brew-")), "bin");
    mkdirSync(dir);
    const bin = join(dir, "espeak-ng");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    process.env.PATH = `${dir}:/nonexistent`;
    delete process.env.ESPEAK_NG_BIN;
    const found = await findBinary("espeak-ng");
    // /usr/bin may also have it on this machine; PATH order wins.
    expect(found).toBe(bin);
  });
  it("honours an explicit override and reports a missing one as absent", async () => {
    process.env.ESPEAK_NG_BIN = "/definitely/not/here/espeak-ng";
    expect(await findBinary("espeak-ng")).toBeNull();
  });
});
