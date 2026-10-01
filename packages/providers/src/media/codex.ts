import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * Images through the owner's ChatGPT plan, via the official Codex CLI signed in with ChatGPT
 * (like the Claude runtime uses Claude Code). `codex exec` runs one turn that calls Codex's
 * built-in image tool; the image lands in `$CODEX_HOME/generated_images/<thread id>/`. No OpenAI
 * API key is ever used: API-key variables are stripped from the child environment and an
 * API-key login is refused. Usage counts against the plan's limits; nothing is billed here.
 */

export const CodexSettings = z.object({
  enabled: z.boolean().default(false),
  /** When another image provider is also configured, whether image shots use Codex first. */
  preferForImages: z.boolean().default(true),
});
export type CodexSettings = z.infer<typeof CodexSettings>;

/** Variables that would make Codex bill an API account instead of the ChatGPT plan. */
export const CODEX_BILLING_OVERRIDE_VARS = ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"];

export function codexEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const v of CODEX_BILLING_OVERRIDE_VARS) delete env[v];
  return env;
}

export type CodexErrorCode = "login_required" | "billing_mismatch" | "usage_limit" | "upgrade_required" | "unavailable" | "no_image" | "provider_failed" | "canceled";

export class CodexError extends Error {
  constructor(
    public code: CodexErrorCode,
    message: string,
    public retryable: boolean,
    public recovery?: string,
  ) {
    super(message);
  }
}

export type CodexRunner = (args: string[], opts: { stdin?: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const codexBin = () => process.env.CODEX_PATH || "codex";

export const spawnCodex: CodexRunner = (args, opts) =>
  new Promise((resolve, reject) => {
    const p = spawn(codexBin(), args, { env: opts.env, stdio: ["pipe", "pipe", "pipe"], signal: opts.signal });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => p.kill("SIGTERM"), opts.timeoutMs);
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr = (stderr + d).slice(-20_000)));
    p.on("error", (e) => (clearTimeout(timer), reject(e)));
    p.on("close", (code) => (clearTimeout(timer), resolve({ code, stdout, stderr })));
    p.stdin.on("error", () => {});
    p.stdin.end(opts.stdin ?? "");
  });

const isEnoent = (e: unknown) => (e as { code?: string })?.code === "ENOENT";
const NOT_FOUND = new CodexError("unavailable", "The Codex CLI was not found on this computer.", false, "Install it (npm install -g @openai/codex), run codex and sign in with ChatGPT, or set CODEX_PATH in .env.");

export type CodexRuntimeState = "ready" | "login_required" | "billing_mismatch" | "unavailable";
export interface CodexRuntimeCheck {
  state: CodexRuntimeState;
  message: string;
  version?: string;
}

/** Local check only: version, login method and the image tool flag. Sends no prompt and uses no plan usage. */
export async function checkCodexRuntime(o: { run?: CodexRunner; env?: NodeJS.ProcessEnv } = {}): Promise<CodexRuntimeCheck> {
  const run = o.run ?? spawnCodex;
  const env = codexEnv(o.env);
  const call = (args: string[]) => run(args, { env, timeoutMs: 20_000 });
  let version: string | undefined;
  try {
    const v = await call(["--version"]);
    version = /(\d+\.\d+\.\d+)/.exec(v.stdout + v.stderr)?.[1];
    const login = await call(["login", "status"]);
    const text = login.stdout + login.stderr;
    if (/api key/i.test(text)) return { state: "billing_mismatch", version, message: "Codex is signed in with an OpenAI API key, which bills your API account. Run codex logout, then codex login and choose Sign in with ChatGPT." };
    if (login.code !== 0 || !/chatgpt/i.test(text)) return { state: "login_required", version, message: "Codex is not signed in with ChatGPT. Run codex login in a terminal and choose Sign in with ChatGPT." };
    const features = await call(["features", "list"]);
    const flag = /^image_generation\s+\S+\s+(true|false)/m.exec(features.stdout)?.[1];
    if (flag === "false") return { state: "unavailable", version, message: "Codex image generation is turned off. Run codex features enable image_generation." };
    return { state: "ready", version, message: `Codex ${version ?? ""} is signed in with ChatGPT. Images use your ChatGPT plan's limits.`.replace("  ", " ") };
  } catch (e) {
    if (isEnoent(e)) return { state: "unavailable", message: `${NOT_FOUND.message} ${NOT_FOUND.recovery}` };
    return { state: "unavailable", version, message: `Codex could not be checked: ${(e as Error).message.slice(0, 200)}` };
  }
}

export function codexImagePrompt(prompt: string, aspectRatio: string, references: number): string {
  return [
    "Use your image generation tool to create exactly one image. Do not run commands, edit files or browse the web.",
    `Aspect ratio: ${aspectRatio}.`,
    references ? `Keep the products, characters and colours consistent with the attached reference image${references > 1 ? "s" : ""}.` : "",
    "Image description:",
    prompt,
  ]
    .filter(Boolean)
    .join("\n");
}

export function classifyCodexFailure(message: string): CodexError {
  const m = message.slice(0, 400);
  if (/usage limit|hit your limit|rate.?limit|too many requests|\b429\b|quota/i.test(m)) return new CodexError("usage_limit", `Your ChatGPT plan's Codex usage limit was reached. The job is paused; it was not moved to paid API billing. ${m}`, false, "Resume once your limit resets.");
  if (/newer version|upgrade to the latest/i.test(m)) return new CodexError("upgrade_required", `Codex needs an update: ${m}`, false, "Run codex update in a terminal, then retry.");
  if (/not logged in|unauthori[sz]ed|\b401\b|codex login|sign in/i.test(m)) return new CodexError("login_required", "Codex is not signed in with ChatGPT.", false, "Run codex login and choose Sign in with ChatGPT, then check Settings → Images with ChatGPT.");
  return new CodexError("provider_failed", `Codex could not generate the image: ${m}`, false, "Adjust the prompt and use Regenerate.");
}

export interface CodexImageRequest {
  prompt: string;
  /** Reference image files (product shots, character sheets) attached with -i. */
  referencePaths: string[];
  aspectRatio: string;
  /** Working directory for the Codex turn (read-only sandbox). */
  cwd: string;
  signal?: AbortSignal;
}

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

export class CodexImages {
  private run: CodexRunner;
  private home: string;
  private env: NodeJS.ProcessEnv;
  constructor(o: { run?: CodexRunner; codexHome?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.run = o.run ?? spawnCodex;
    this.env = codexEnv(o.env);
    this.home = o.codexHome ?? this.env.CODEX_HOME ?? join(homedir(), ".codex");
  }

  async generate(req: CodexImageRequest): Promise<{ file: string; threadId: string }> {
    const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "-C", req.cwd, ...req.referencePaths.flatMap((p) => ["-i", p])];
    let out;
    try {
      out = await this.run(args, { stdin: codexImagePrompt(req.prompt, req.aspectRatio, req.referencePaths.length), env: this.env, signal: req.signal, timeoutMs: 6 * 60_000 });
    } catch (e) {
      if (isEnoent(e)) throw NOT_FOUND;
      if (req.signal?.aborted) throw new CodexError("canceled", "Canceled.", false);
      throw new CodexError("provider_failed", `Codex did not run: ${(e as Error).message.slice(0, 200)}`, true);
    }
    if (req.signal?.aborted) throw new CodexError("canceled", "Canceled.", false);
    let threadId: string | null = null;
    const failures: string[] = [];
    for (const line of out.stdout.split("\n")) {
      if (!line.trim()) continue;
      let ev: { type?: string; thread_id?: string; message?: string; error?: { message?: string } };
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "thread.started" && ev.thread_id) threadId = ev.thread_id;
      // Top-level errors fail the turn; item-level "error" items are warnings and are ignored.
      if (ev.type === "turn.failed") failures.push(ev.error?.message ?? "turn failed");
      if (ev.type === "error" && ev.message) failures.push(ev.message);
    }
    if (failures.length || out.code !== 0) throw classifyCodexFailure(failures.at(-1) ?? (out.stderr.trim().split("\n").at(-1) || `codex exited with code ${out.code}`));
    if (!threadId) throw new CodexError("provider_failed", "Codex did not report a session, so its image could not be found.", false);
    const dir = join(this.home, "generated_images", threadId);
    const files = await readdir(dir).catch(() => [] as string[]);
    const images = await Promise.all(files.filter((f) => IMAGE_EXT.test(f)).map(async (f) => ({ f: join(dir, f), t: (await stat(join(dir, f))).mtimeMs })));
    const newest = images.sort((a, b) => b.t - a.t)[0];
    if (!newest) throw new CodexError("no_image", "Codex finished without making an image.", false, "Check that image generation works in Codex itself, adjust the prompt, and use Regenerate.");
    return { file: newest.f, threadId };
  }
}

/**
 * Which provider image shots and keyframes use. Shared by the Shots panel and the worker so the
 * panel never shows a different provider (or price) than the one that runs.
 */
export function pickImageProvider(o: { codex: CodexSettings | null; codexAllowed: boolean; openRouterReady: boolean; openRouterPreferred: boolean; falImage: boolean }): "codex" | "openrouter" | "fal" | null {
  const codexOn = !!o.codex?.enabled && o.codexAllowed;
  if (codexOn && (o.codex!.preferForImages || (!o.openRouterReady && !o.falImage))) return "codex";
  if (o.openRouterReady && (o.openRouterPreferred || !o.falImage)) return "openrouter";
  return o.falImage ? "fal" : null;
}

/** Codex images cost no money: they use the ChatGPT plan's limits. */
export const CODEX_PLAN_BASIS = "included in your ChatGPT plan (Codex CLI)";
