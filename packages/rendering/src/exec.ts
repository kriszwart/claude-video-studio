import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a binary with an argument array (never a shell string). */
export function run(bin: string, args: string[], opts: { signal?: AbortSignal; timeoutMs?: number; input?: Buffer } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], signal: opts.signal });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => {
      err.push(d);
      // Bound memory: keep only the most recent stderr.
      while (err.length > 400) err.shift();
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    if (opts.input) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export async function runOk(bin: string, args: string[], opts: Parameters<typeof run>[2] = {}): Promise<ExecResult> {
  const r = await run(bin, args, opts);
  if (r.code !== 0) throw new Error(`${bin} exited with ${r.code}: ${r.stderr.slice(-1500)}`);
  return r;
}

export const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
