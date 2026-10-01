import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCodexRuntime, CodexError, CodexImages, codexEnv, codexImagePrompt, type CodexRunner } from "../src";

function runner(results: Record<string, { code: number | null; stdout?: string; stderr?: string } | Error>) {
  const calls: { args: string[]; stdin?: string; env: NodeJS.ProcessEnv }[] = [];
  const run: CodexRunner = async (args, opts) => {
    calls.push({ args, stdin: opts.stdin, env: opts.env });
    const r = results[args.slice(0, 2).join(" ")] ?? results[args[0]!];
    if (!r) throw new Error(`unexpected codex call: ${args.join(" ")}`);
    if (r instanceof Error) throw r;
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
const enoent = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });

describe("Codex runtime check", () => {
  const ok = { "--version": { code: 0, stdout: "codex-cli 0.159.3\n" }, "features list": { code: 0, stdout: "image_generation                     stable             true\n" } };

  it("is ready when signed in with ChatGPT and image generation is on", async () => {
    const { run } = runner({ ...ok, "login status": { code: 0, stderr: "Logged in using ChatGPT\n" } });
    expect(await checkCodexRuntime({ run })).toMatchObject({ state: "ready", version: "0.159.3" });
  });

  it("refuses an API-key login so images never bill the OpenAI API", async () => {
    const { run } = runner({ ...ok, "login status": { code: 0, stdout: "Logged in using an API key - sk-proj-***ABCD\n" } });
    const r = await checkCodexRuntime({ run });
    expect(r.state).toBe("billing_mismatch");
    expect(r.message).not.toMatch(/sk-/);
  });

  it("asks for a login when signed out, and reports a missing CLI or disabled image tool", async () => {
    expect((await checkCodexRuntime({ run: runner({ ...ok, "login status": { code: 1, stderr: "Not logged in\n" } }).run })).state).toBe("login_required");
    expect((await checkCodexRuntime({ run: runner({ "--version": enoent }).run })).state).toBe("unavailable");
    const off = runner({ ...ok, "login status": { code: 0, stderr: "Logged in using ChatGPT" }, "features list": { code: 0, stdout: "image_generation  stable  false\n" } });
    expect(await checkCodexRuntime({ run: off.run })).toMatchObject({ state: "unavailable", message: expect.stringMatching(/image generation/i) });
  });

  it("strips API-key variables from the Codex environment", () => {
    const env = codexEnv({ PATH: "/bin", OPENAI_API_KEY: "sk-1", CODEX_API_KEY: "x", OPENAI_BASE_URL: "http://proxy", HOME: "/h" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("Codex images", () => {
  async function codexHome(threadId: string, files: string[]) {
    const home = await mkdtemp(join(tmpdir(), "codex-home-"));
    const dir = join(home, "generated_images", threadId);
    await mkdir(dir, { recursive: true });
    for (const f of files) await writeFile(join(dir, f), "png");
    return home;
  }

  it("runs codex exec with the prompt on stdin and references as -i, then finds the thread's image", async () => {
    const home = await codexHome("thr-1", ["exec-a.png"]);
    const { run, calls } = runner({ exec: { code: 0, stdout: jsonl({ type: "thread.started", thread_id: "thr-1" }, { type: "turn.completed", usage: { input_tokens: 10 } }) } });
    const r = await new CodexImages({ run, codexHome: home, env: { PATH: "/bin", OPENAI_API_KEY: "sk-1" } }).generate({ prompt: "A robot", referencePaths: ["/w/ref-0.png", "/w/ref-1.jpg"], aspectRatio: "9:16", cwd: "/w" });
    expect(r).toEqual({ file: join(home, "generated_images", "thr-1", "exec-a.png"), threadId: "thr-1" });
    const c = calls[0]!;
    expect(c.args).toEqual(["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "-C", "/w", "-i", "/w/ref-0.png", "-i", "/w/ref-1.jpg"]);
    expect(c.stdin).toBe(codexImagePrompt("A robot", "9:16", 2));
    expect(c.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("builds a prompt that asks for one image, the aspect ratio and reference consistency", () => {
    const p = codexImagePrompt("A bottle on sand", "16:9", 1);
    expect(p).toMatch(/exactly one image/);
    expect(p).toMatch(/16:9/);
    expect(p).toMatch(/attached reference image/);
    expect(p.endsWith("A bottle on sand")).toBe(true);
    expect(codexImagePrompt("x", "1:1", 0)).not.toMatch(/reference/);
  });

  it.each([
    ["You've hit your usage limit. Try again at 3:45 PM.", "usage_limit"],
    ["The 'gpt-6' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.", "upgrade_required"],
    ["401 Unauthorized: please run codex login", "login_required"],
    ["Something else went wrong", "provider_failed"],
  ])("classifies a failed turn %j as %s", async (message, code) => {
    const { run } = runner({ exec: { code: 1, stdout: jsonl({ type: "thread.started", thread_id: "t" }, { type: "turn.failed", error: { message } }) } });
    const e = await new CodexImages({ run, codexHome: "/none", env: {} }).generate({ prompt: "p", referencePaths: [], aspectRatio: "1:1", cwd: "/w" }).catch((x) => x);
    expect(e).toBeInstanceOf(CodexError);
    expect(e.code).toBe(code);
  });

  it("ignores warning items and fails clearly when the turn finishes without an image", async () => {
    const home = await codexHome("thr-2", []);
    const { run } = runner({ exec: { code: 0, stdout: jsonl({ type: "thread.started", thread_id: "thr-2" }, { type: "item.completed", item: { type: "error", message: "Model metadata not found" } }, { type: "turn.completed" }) } });
    await expect(new CodexImages({ run, codexHome: home, env: {} }).generate({ prompt: "p", referencePaths: [], aspectRatio: "1:1", cwd: "/w" })).rejects.toMatchObject({ code: "no_image" });
  });

  it("reports a missing Codex CLI", async () => {
    const { run } = runner({ exec: enoent });
    await expect(new CodexImages({ run, codexHome: "/none", env: {} }).generate({ prompt: "p", referencePaths: [], aspectRatio: "1:1", cwd: "/w" })).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("image provider choice", () => {
  const base = { codex: { enabled: true, preferForImages: true }, codexAllowed: true, openRouterReady: true, openRouterPreferred: true, falImage: true };
  it("prefers Codex when on and preferred, and falls back in order", async () => {
    const { pickImageProvider } = await import("../src");
    expect(pickImageProvider(base)).toBe("codex");
    expect(pickImageProvider({ ...base, codex: { enabled: true, preferForImages: false } })).toBe("openrouter");
    expect(pickImageProvider({ ...base, codex: { enabled: true, preferForImages: false }, openRouterReady: false })).toBe("fal");
    expect(pickImageProvider({ ...base, codex: { enabled: true, preferForImages: false }, openRouterReady: false, falImage: false })).toBe("codex");
    expect(pickImageProvider({ ...base, codex: { enabled: false, preferForImages: true } })).toBe("openrouter");
    expect(pickImageProvider({ ...base, codexAllowed: false, openRouterReady: false, falImage: false })).toBeNull();
  });
});
