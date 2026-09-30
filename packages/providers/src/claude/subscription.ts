import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { query as sdkQuery, type AccountInfo, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CONFIG, imageBlocks, parseJson, ProviderError, type ChatTurn, type ClaudeBackend, type RateLimitSnapshot, type StructuredCall, type StructuredResult } from "./client";

/**
 * Subscription-first Claude runtime (PRD §28). Calls go through the official Claude Agent SDK,
 * which runs the owner's locally installed, signed-in Claude Code. The studio never reads,
 * copies or stores the login: the SDK process manages it. Before any prompt is sent the account
 * is checked, so a runtime that would bill an API key is refused rather than used.
 */

export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

export interface SubscriptionRuntimeOptions {
  /** Test seam: the SDK's query function. */
  queryFn?: QueryFn;
  /** Source environment (defaults to process.env). Only an allowlist is passed on. */
  sourceEnv?: NodeJS.ProcessEnv;
  /** Parent directory for per-call scratch working directories. */
  workRoot?: string;
  /** Scope label (e.g. project id) used in the scratch directory name. */
  scope?: string;
  /** Upper bound for one call, including repair turns inside the SDK. */
  timeoutMs?: number;
}

/** Environment variables that would switch Claude Code to separately billed or third-party access. */
export const BILLING_OVERRIDE_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/** Names only — values are never read beyond a presence check, returned, logged or stored. */
export function detectBillingOverrides(env: NodeJS.ProcessEnv = process.env): string[] {
  return BILLING_OVERRIDE_VARS.filter((k) => typeof env[k] === "string" && env[k] !== "");
}

/** What the Claude Code process may see: OS basics, proxy/CA settings and Claude Code's own config location. */
const ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "TERM",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT", "HOMEDRIVE", "HOMEPATH",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
  // Claude Code's own configuration directory and its long-lived subscription token (created by
  // `claude setup-token`). Passed through untouched to the official process; never read here.
  "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export function runtimeEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = source[k];
    if (typeof v === "string" && v !== "") env[k] = v;
  }
  // Keep the runtime quiet: no self-update or telemetry side effects from studio calls.
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

export type ObservedMode = "subscription" | "api_key" | "third_party" | "signed_out" | "unknown";

/** Classify the signed-in account. Only a positively identified Claude plan counts as subscription. */
export function classifyAccount(a: AccountInfo | null | undefined): { observed: ObservedMode; plan: string | null } {
  if (!a) return { observed: "signed_out", plan: null };
  const plan = a.subscriptionType?.trim() || null;
  if (a.apiProvider && a.apiProvider !== "firstParty") return { observed: "third_party", plan };
  if (a.apiKeySource && a.apiKeySource !== "none" && a.apiKeySource !== "oauth") return { observed: "api_key", plan };
  if (plan && /\bapi\b|console/i.test(plan)) return { observed: "api_key", plan };
  if (plan && /max|pro|team|enterprise/i.test(plan)) return { observed: "subscription", plan };
  if (!plan && !a.tokenSource && !a.email && !a.organization) return { observed: "signed_out", plan: null };
  return { observed: "unknown", plan };
}

export const RUNTIME_SETUP =
  "Install Claude Code, run `claude` in a terminal on this computer and sign in with /login using your Claude subscription (Pro/Max). Then click “Check runtime” in Settings → Claude.";

function mismatch(observed: ObservedMode, plan: string | null): ProviderError {
  if (observed === "signed_out") return new ProviderError("runtime_login_required", "Claude Code is not signed in on this computer, so AI actions are unavailable.", false, RUNTIME_SETUP);
  const what =
    observed === "api_key" ? `an API key / Console account${plan ? ` (${plan})` : ""}` : observed === "third_party" ? "a third-party cloud provider" : `an account type the studio can't confirm as a subscription${plan ? ` (${plan})` : ""}`;
  return new ProviderError(
    "billing_mode_mismatch",
    `Subscription mode is selected, but Claude Code on this computer is signed in with ${what}. Nothing was sent, so nothing was billed.`,
    false,
    "Sign in to Claude Code with your Claude subscription (/login), or explicitly switch Settings → Claude to API mode if you want separately billed API usage.",
    { observed, plan },
  );
}

function snapshot(info: { status: RateLimitSnapshot["status"]; rateLimitType?: string; resetsAt?: number; utilization?: number }): RateLimitSnapshot {
  return {
    status: info.status,
    ...(info.rateLimitType ? { rateLimitType: info.rateLimitType } : {}),
    ...(typeof info.resetsAt === "number" ? { resetsAt: new Date(info.resetsAt * 1000).toISOString() } : {}),
    ...(typeof info.utilization === "number" ? { utilization: info.utilization } : {}),
    at: new Date().toISOString(),
  };
}

const LIMIT_NAMES: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
};

export function usageLimitError(limit: RateLimitSnapshot | null): ProviderError {
  const name = limit?.rateLimitType ? LIMIT_NAMES[limit.rateLimitType] ?? limit.rateLimitType.replace(/_/g, " ") : null;
  const when = limit?.resetsAt ? ` It resets at ${limit.resetsAt}.` : "";
  return new ProviderError(
    "usage_limit",
    `Your Claude plan's ${name ? `${name} ` : ""}usage limit was reached. The job is paused and your project is unchanged; it was not moved to paid API billing.${when}`,
    false,
    `Resume the job after the limit resets${limit?.resetsAt ? ` (${limit.resetsAt})` : ""}. The studio never switches accounts, enables extra usage or falls back to an API key on its own.`,
    { resetsAt: limit?.resetsAt ?? null, rateLimitType: limit?.rateLimitType ?? null },
  );
}

/** Map runtime failures (assistant error codes, result errors, process errors) to typed errors. */
export function classifyRuntimeFailure(f: { assistantError?: string | null; errors?: string[]; limit?: RateLimitSnapshot | null; cause?: unknown }): ProviderError {
  if (f.cause instanceof ProviderError) return f.cause;
  if (f.limit?.status === "rejected") return usageLimitError(f.limit);
  const text = [...(f.errors ?? []), f.cause instanceof Error ? f.cause.message : f.cause ? String(f.cause) : ""].join(" ");
  const code = f.assistantError ?? "";
  if (code === "rate_limit" || code === "billing_error" || /usage limit|limit reached|out of (extra )?usage|rate.?limit/i.test(text)) return usageLimitError(f.limit ?? null);
  if (["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required"].includes(code) || /not logged in|please run \/login|\/login|invalid api key|authenticat|unauthori[sz]ed|oauth/i.test(text)) {
    return new ProviderError("runtime_login_required", "Claude Code could not authenticate with your Claude account.", false, RUNTIME_SETUP);
  }
  if ((f.cause as { name?: string } | undefined)?.name === "AbortError" || /aborted|abort(ed)? by user|canceled|cancelled/i.test(text)) return new ProviderError("canceled", "Canceled.", false);
  if (/ENOENT|executable not found|spawn|not installed|native binary/i.test(text)) {
    return new ProviderError("runtime_unavailable", "The Claude Code runtime could not be started on this computer.", false, `${RUNTIME_SETUP} If Claude Code is installed in a non-standard place, set CLAUDE_CODE_EXECUTABLE.`);
  }
  if (code === "overloaded" || code === "server_error") return new ProviderError("provider_unavailable", "Claude is temporarily unavailable.", true);
  if (code === "model_not_found") return new ProviderError("bad_request", `The configured model (${CLAUDE_CONFIG.model}) is not available to this Claude account.`, false, "Set CLAUDE_MODEL to a model your plan includes.");
  if (code === "invalid_request") return new ProviderError("bad_request", "Claude rejected the request.", false);
  if (code === "max_output_tokens") return new ProviderError("invalid_output", "Claude's response was cut off before it finished.", true);
  return new ProviderError("provider_unavailable", "The Claude Code runtime failed while handling this request.", true, "Check the worker log; retry, or run `claude` in a terminal to confirm it works.");
}

/** Render a multi-turn exchange (e.g. a repair round) as one prompt; single turns pass through. */
export function renderTurns(turns: ChatTurn[]): string {
  if (turns.length === 1) return turns[0]!.content;
  return turns
    .map((t, i) => (i === 0 ? `<request>\n${t.content}\n</request>` : t.role === "assistant" ? `<your_previous_response>\n${t.content}\n</your_previous_response>` : `<follow_up>\n${t.content}\n</follow_up>`))
    .join("\n\n");
}

/** A single-message input stream that stays open until closed, so the account can be checked before sending. */
function inputChannel() {
  let push: ((m: SDKUserMessage) => void) | null = null;
  let finish: (() => void) | null = null;
  const queue: SDKUserMessage[] = [];
  let done = false;
  const iterable: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          push = (m) => {
            queue.push(m);
            resolve();
          };
          finish = resolve;
        });
      }
    },
  };
  return {
    iterable,
    send(m: SDKUserMessage) {
      if (push) push(m);
      else queue.push(m);
    },
    end() {
      done = true;
      finish?.();
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(onTimeout()), ms)))]).finally(() => clearTimeout(t));
}

function baseOptions(o: SubscriptionRuntimeOptions, cwd: string, abortController: AbortController): Options {
  return {
    cwd,
    env: runtimeEnv(o.sourceEnv ?? process.env),
    abortController,
    // No built-in tools, no MCP servers, no user/project settings or CLAUDE.md, no saved session:
    // the model can only answer with the structured output the studio asked for.
    tools: [],
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    persistSession: false,
    permissionMode: "dontAsk",
    ...(process.env.CLAUDE_CODE_EXECUTABLE ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE } : {}),
  };
}

async function scratchDir(o: SubscriptionRuntimeOptions): Promise<string> {
  const root = o.workRoot ?? process.env.STUDIO_CLAUDE_WORKDIR ?? join(tmpdir(), "claude-video-studio");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, `${(o.scope ?? "call").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "call"}-`));
}

export interface SubscriptionCallInfo {
  observed: ObservedMode;
  plan: string | null;
  limit: RateLimitSnapshot | null;
}

/** The default Claude backend: the owner's subscription through the local Claude Code runtime. */
export function subscriptionBackend(o: SubscriptionRuntimeOptions = {}): ClaudeBackend & { lastCall: SubscriptionCallInfo | null } {
  const backend = {
    kind: "subscription" as const,
    lastCall: null as SubscriptionCallInfo | null,
    async structured(call: StructuredCall): Promise<StructuredResult> {
      const queryFn = await resolveQuery(o);
      if (call.signal?.aborted) throw new ProviderError("canceled", "Canceled.", false);
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      call.signal?.addEventListener("abort", onAbort, { once: true });
      const timeoutMs = o.timeoutMs ?? Number(process.env.CLAUDE_RUNTIME_TIMEOUT_MS ?? 15 * 60_000);
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      const cwd = await scratchDir(o);
      const input = inputChannel();
      let q: Query | null = null;
      let limit: RateLimitSnapshot | null = null;
      let assistantError: string | null = null;
      let model: string | null = null;
      try {
        q = queryFn({
          prompt: input.iterable,
          options: {
            ...baseOptions(o, cwd, abort),
            systemPrompt: call.system,
            model: CLAUDE_CONFIG.model,
            effort: call.effort ?? CLAUDE_CONFIG.effort,
            // The structured answer takes one turn; the SDK may use one more to repair its own schema mismatch.
            maxTurns: 3,
            outputFormat: { type: "json_schema", schema: call.schema },
          },
        });
        // 1) Confirm the runtime bills the owner's subscription before anything is sent.
        const account = await withTimeout(q.accountInfo(), 60_000, () => new ProviderError("runtime_unavailable", "The Claude Code runtime did not respond.", true, RUNTIME_SETUP));
        const cls = classifyAccount(account);
        backend.lastCall = { observed: cls.observed, plan: cls.plan, limit: null };
        if (cls.observed !== "subscription") throw mismatch(cls.observed, cls.plan);

        // 2) Send the request and read the stream until the result.
        const text = renderTurns(call.messages);
        input.send({ type: "user", message: { role: "user", content: call.images?.length ? [{ type: "text", text }, ...imageBlocks(call.images)] : text }, parent_tool_use_id: null });
        let result: Extract<SDKMessage, { type: "result" }> | null = null;
        for await (const m of q) {
          if (m.type === "system" && m.subtype === "init") {
            model = m.model;
            if (m.apiKeySource && !["none", "oauth"].includes(m.apiKeySource)) {
              abort.abort();
              throw mismatch("api_key", cls.plan);
            }
          } else if (m.type === "rate_limit_event") {
            limit = snapshot(m.rate_limit_info);
            backend.lastCall.limit = limit;
            if (limit.status === "rejected") {
              abort.abort();
              throw usageLimitError(limit);
            }
          } else if (m.type === "assistant") {
            if (m.error) assistantError = m.error;
            model = m.message.model ?? model;
          } else if (m.type === "result") {
            result = m;
            break;
          }
        }
        if (call.signal?.aborted) throw new ProviderError("canceled", "Canceled.", false);
        if (!result) throw classifyRuntimeFailure({ assistantError, limit, errors: ["The runtime ended without a result."] });
        if (result.subtype !== "success") {
          if (result.subtype === "error_max_structured_output_retries" || result.subtype === "error_max_turns") {
            throw new ProviderError("invalid_output", "Claude did not return output matching the required structure.", true);
          }
          throw classifyRuntimeFailure({ assistantError, limit, errors: result.errors });
        }
        if (result.is_error) throw classifyRuntimeFailure({ assistantError, limit, errors: [result.result] });
        const json = result.structured_output !== undefined ? result.structured_output : parseJson(result.result);
        if (!json || typeof json !== "object") throw new ProviderError("invalid_output", "Claude returned no structured output.", true);
        const usedModel = model ?? Object.keys(result.modelUsage ?? {})[0] ?? CLAUDE_CONFIG.model;
        return {
          json,
          text: JSON.stringify(json),
          usage: {
            inputTokens: result.usage.input_tokens ?? 0,
            outputTokens: result.usage.output_tokens ?? 0,
            cacheReadTokens: result.usage.cache_read_input_tokens ?? 0,
            model: usedModel,
            runtime: "subscription",
            limit,
          },
        };
      } catch (e) {
        if (call.signal?.aborted) throw new ProviderError("canceled", "Canceled.", false);
        if (e instanceof ProviderError) throw e;
        if (abort.signal.aborted) throw new ProviderError("provider_unavailable", "The Claude Code runtime timed out.", true);
        throw classifyRuntimeFailure({ assistantError, limit, cause: e });
      } finally {
        clearTimeout(timer);
        call.signal?.removeEventListener("abort", onAbort);
        input.end();
        try {
          q?.close();
        } catch {
          /* already closed */
        }
        await rm(cwd, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
  return backend;
}

/**
 * The SDK's query(), or — outside production only — a test double module named by
 * STUDIO_CLAUDE_SDK_DOUBLE (see scripts/fake-claude-sdk.mjs), like the fake fal queue.
 */
async function resolveQuery(o: SubscriptionRuntimeOptions): Promise<QueryFn> {
  if (o.queryFn) return o.queryFn;
  const double = process.env.STUDIO_CLAUDE_SDK_DOUBLE;
  if (double && process.env.NODE_ENV !== "production") {
    const root = process.env.STUDIO_REPO_ROOT ?? process.cwd();
    const mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ pathToFileURL(resolve(root, double)).href)) as { query: QueryFn };
    return mod.query;
  }
  return sdkQuery;
}

export type RuntimeState = "ready" | "login_required" | "billing_mismatch" | "unavailable";

export interface RuntimeCheck {
  ok: boolean;
  state: RuntimeState;
  observed: ObservedMode;
  plan: string | null;
  message: string;
  recovery?: string;
  /** Names of environment variables that could switch billing (values never read out). */
  overrides: string[];
  at: string;
}

/**
 * Status check without a model call: start the runtime, ask which account it is signed in
 * with, and stop. Nothing is sent to Claude, so it uses none of the plan's usage.
 */
export async function checkClaudeRuntime(o: SubscriptionRuntimeOptions = {}): Promise<RuntimeCheck> {
  const overrides = detectBillingOverrides(o.sourceEnv ?? process.env);
  const at = new Date().toISOString();
  const queryFn = await resolveQuery(o);
  const abort = new AbortController();
  const input = inputChannel();
  let q: Query | null = null;
  const cwd = await scratchDir({ ...o, scope: "check" });
  try {
    q = queryFn({ prompt: input.iterable, options: baseOptions(o, cwd, abort) });
    const account = await withTimeout(q.accountInfo(), o.timeoutMs ?? 60_000, () => new Error("The Claude Code runtime did not respond."));
    const { observed, plan } = classifyAccount(account);
    if (observed === "subscription") return { ok: true, state: "ready", observed, plan, message: `Claude Code is signed in with a Claude subscription (${plan}). AI actions use your plan's usage limits.`, overrides, at };
    const err = mismatch(observed, plan);
    return { ok: false, state: observed === "signed_out" ? "login_required" : "billing_mismatch", observed, plan, message: err.message.replace(" Nothing was sent, so nothing was billed.", ""), recovery: err.recovery, overrides, at };
  } catch (e) {
    const err = classifyRuntimeFailure({ cause: e });
    const state: RuntimeState = err.code === "runtime_login_required" ? "login_required" : "unavailable";
    return { ok: false, state, observed: state === "login_required" ? "signed_out" : "unknown", plan: null, message: err.message, recovery: err.recovery ?? RUNTIME_SETUP, overrides, at };
  } finally {
    abort.abort();
    input.end();
    try {
      q?.close();
    } catch {
      /* already closed */
    }
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
