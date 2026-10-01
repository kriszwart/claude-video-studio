import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { findBinary, LocalTts, parseSayVoices } from "../src";

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

describe("local TTS pace", () => {
  it.skipIf(!existsSync("/usr/bin/pico2wave") || !existsSync("/usr/bin/ffmpeg"))("pico follows the rate through a pitch-preserving tempo change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pico-"));
    const tts = new LocalTts();
    const len = async (rate: number) => {
      const r = await tts.synthesize("Focus time is the part of your week that meetings cannot touch.", "pico:en-US", join(dir, `r${rate}.wav`), { rate });
      return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", r.file]).toString());
    };
    const normal = await len(1);
    const slower = await len(0.9);
    expect(slower / normal).toBeGreaterThan(1.08);
    expect(slower / normal).toBeLessThan(1.14);
  });
});

describe("macOS voices (say)", () => {
  it("offers only the natural English voices that are installed, best first", () => {
    const listing = [
      "Albert              en_US    # Hello! My name is Albert.",
      "Daniel              en_GB    # Hello! My name is Daniel.",
      "Samantha            en_US    # Hello! My name is Samantha.",
      "Thomas              fr_FR    # Bonjour, je m’appelle Thomas.",
      "Zoe (Premium)       en_US    # Hello! My name is Zoe.",
    ].join("\n");
    expect(parseSayVoices(listing).map((v) => [v.id, v.language])).toEqual([
      ["say:Zoe (Premium)", "en-US"],
      ["say:Samantha", "en-US"],
      ["say:Daniel", "en-GB"],
    ]);
  });

  it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/say"))("speaks to a WAV file and follows the rate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "say-"));
    const tts = new LocalTts();
    const voice = (await tts.voices()).find((v) => v.id.startsWith("say:"));
    expect(voice).toBeDefined();
    const len = async (rate: number) => {
      const r = await tts.synthesize("Focus time is the part of your week that meetings cannot touch.", voice!.id, join(dir, `r${rate}.wav`), { rate });
      expect(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", r.file]).toString().trim()).toMatch(/^pcm_s16le/);
      return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", r.file]).toString());
    };
    const normal = await len(1);
    expect(normal).toBeGreaterThan(1.5);
    expect((await len(0.8)) / normal).toBeGreaterThan(1.1);
  });
});
