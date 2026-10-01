import { describe, expect, it } from "vitest";
import { classifyEnvironmentError } from "../src/envErrors";

const err = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);

describe("environment errors get a clear message and a fix instead of 'internal error'", () => {
  it("render browser without software graphics (the SwiftShader check)", () => {
    const e = Object.assign(err('[assertSwiftShader] Chrome reported a non-SwiftShader WebGL backend. Got vendor="" renderer=""'), { name: "SwiftShaderAssertionError", code: "BROWSER_GPU_NOT_SOFTWARE" });
    expect(classifyEnvironmentError(e)).toMatchObject({ code: "renderer_browser", retryable: false, recovery: expect.stringMatching(/HYPERFRAMES_CHROME_PATH/) });
  });

  it("render browser not installed", () => {
    expect(classifyEnvironmentError(err("browserType.launch: Failed to launch chromium because executable doesn't exist at /opt/pw-browsers/x")))?.toMatchObject({ code: "renderer_browser_missing", retryable: false });
    expect(classifyEnvironmentError(err("spawn /Users/me/chrome-headless-shell ENOENT", { code: "ENOENT", path: "/Users/me/chrome-headless-shell" })))?.toMatchObject({ code: "renderer_browser_missing" });
  });

  it("FFmpeg not installed", () => {
    expect(classifyEnvironmentError(err("spawn ffmpeg ENOENT", { code: "ENOENT", path: "ffmpeg" })))?.toMatchObject({ code: "ffmpeg_missing", retryable: false, recovery: expect.stringMatching(/brew install ffmpeg/) });
  });

  it("disk full", () => {
    expect(classifyEnvironmentError(err("ENOSPC: no space left on device, write", { code: "ENOSPC" })))?.toMatchObject({ code: "disk_full", retryable: false });
  });

  it("leaves everything else to the generic handler", () => {
    expect(classifyEnvironmentError(err("Cannot read properties of undefined (reading 'x')"))).toBeNull();
    expect(classifyEnvironmentError("not an error")).toBeNull();
  });
});
