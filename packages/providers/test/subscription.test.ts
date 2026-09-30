import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AccountInfo, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { checkClaudeRuntime, classifyAccount, detectBillingOverrides, ProviderError, renderTurns, runtimeEnv, subscriptionBackend, type QueryFn } from "../src";

/**
 * Test double at the SDK boundary: records the options and the prompt it was sent, answers
 * accountInfo() with a fixed account and then streams the given messages.
 */
function fakeSdk(account: AccountInfo | Error, messages: SDKMessage[]) {
  const seen: { options?: Options; prompts: string[]; closed: boolean } = { prompts: [], closed: false };
  const queryFn: QueryFn = ({ prompt, options }) => {
    seen.options = options;
    const gen = (async function* () {
      if (typeof prompt !== "string") {
        for await (const m of prompt) {
          seen.prompts.push(String((m as SDKUserMessage).message.content));
          break;
        }
      }
      for (const m of messages) {
        if (options?.abortController?.signal.aborted) throw Object.assign(new Error("Claude Code process aborted by user"), { name: "AbortError" });
        await new Promise((r) => setTimeout(r, 5));
        yield m;
      }
    })();
    return Object.assign(gen, {
      accountInfo: async () => {
        if (account instanceof Error) throw account;
        return account;
      },
      close: () => {
        seen.closed = true;
      },
    }) as unknown as Query;
  };
  return { queryFn, seen };
}

const MAX: AccountInfo = { subscriptionType: "max", apiProvider: "firstParty" };
const init = { type: "system", subtype: "init", model: "claude-opus-5-5", apiKeySource: "none" } as unknown as SDKMessage;
const success = (structured: unknown) =>
  ({ type: "result", subtype: "success", is_error: false, result: "", structured_output: structured, usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 0 }, modelUsage: {} }) as unknown as SDKMessage;
const call = { system: "sys", messages: [{ role: "user" as const, content: "plan it" }], schema: { type: "object" } };

describe("subscription runtime (Claude Agent SDK)", () => {
  it("runs with no tools, isolated settings, a scoped scratch dir and no API-key env", async () => {
    const { queryFn, seen } = fakeSdk(MAX, [init, { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.2, resetsAt: 1_790_000_000 } } as unknown as SDKMessage, success({ ok: true })]);
    const b = subscriptionBackend({ queryFn, scope: "prj_1", sourceEnv: { PATH: "/usr/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "sk-secret", ANTHROPIC_BASE_URL: "http://proxy", CLAUDE_CODE_SESSION_ID: "x" } });
    const r = await b.structured(call);
    expect(r.json).toEqual({ ok: true });
    expect(r.usage).toMatchObject({ runtime: "subscription", inputTokens: 120, outputTokens: 40, model: "claude-opus-5-5", limit: { status: "allowed", rateLimitType: "five_hour", utilization: 0.2 } });
    const o = seen.options!;
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual([]);
    expect(o.settingSources).toEqual([]);
    expect(o.persistSession).toBe(false);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.outputFormat).toEqual({ type: "json_schema", schema: { type: "object" } });
    expect(o.env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/x" });
    expect(Object.keys(o.env!)).not.toContain("ANTHROPIC_API_KEY");
    expect(Object.keys(o.env!)).not.toContain("ANTHROPIC_BASE_URL");
    expect(Object.keys(o.env!)).not.toContain("CLAUDE_CODE_SESSION_ID");
    expect(o.cwd).toMatch(/claude-video-studio\/prj_1-/);
    expect(existsSync(o.cwd!)).toBe(false); // removed after the call
    expect(seen.prompts).toEqual(["plan it"]);
    expect(seen.closed).toBe(true);
  });

  it("refuses an API-key / Console login before sending anything", async () => {
    const { queryFn, seen } = fakeSdk({ subscriptionType: "Claude API", apiProvider: "firstParty" }, [init, success({})]);
    const err = await subscriptionBackend({ queryFn }).structured(call).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("billing_mode_mismatch");
    expect(err.retryable).toBe(false);
    expect(seen.prompts).toEqual([]);
  });

  it("pauses (non-retryable usage_limit) when the plan limit is reached — no fallback", async () => {
    const { queryFn } = fakeSdk(MAX, [init, { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1_790_000_000 } } as unknown as SDKMessage, success({})]);
    const err = await subscriptionBackend({ queryFn }).structured(call).catch((e) => e);
    expect(err.code).toBe("usage_limit");
    expect(err.retryable).toBe(false);
    expect(err.details).toEqual({ resetsAt: new Date(1_790_000_000_000).toISOString(), rateLimitType: "five_hour" });
    expect(err.message).toMatch(/5-hour usage limit/);
    expect(err.message).toMatch(/not moved to paid API billing/);
  });

  it("maps a rate-limit assistant error without limit details to a paused job too", async () => {
    const { queryFn } = fakeSdk(MAX, [init, { type: "assistant", error: "rate_limit", message: { model: "claude-opus-5-5", content: [] } } as unknown as SDKMessage, { type: "result", subtype: "error_during_execution", is_error: true, errors: ["API Error: 429"] } as unknown as SDKMessage]);
    const err = await subscriptionBackend({ queryFn }).structured(call).catch((e) => e);
    expect(err.code).toBe("usage_limit");
  });

  it("reports a lost login as runtime_login_required", async () => {
    const { queryFn } = fakeSdk(MAX, [init, { type: "assistant", error: "authentication_failed", message: { model: "m", content: [] } } as unknown as SDKMessage, { type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login", usage: {}, modelUsage: {} } as unknown as SDKMessage]);
    const err = await subscriptionBackend({ queryFn }).structured(call).catch((e) => e);
    expect(err.code).toBe("runtime_login_required");
  });

  it("cancels when the job is canceled", async () => {
    const { queryFn } = fakeSdk(MAX, [init, init, init, success({})]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 8);
    const err = await subscriptionBackend({ queryFn }).structured({ ...call, signal: ac.signal }).catch((e) => e);
    expect(err.code).toBe("canceled");
  });

  it("treats schema-retry exhaustion as invalid output", async () => {
    const { queryFn } = fakeSdk(MAX, [init, { type: "result", subtype: "error_max_structured_output_retries", is_error: true, errors: [] } as unknown as SDKMessage]);
    const err = await subscriptionBackend({ queryFn }).structured(call).catch((e) => e);
    expect(err.code).toBe("invalid_output");
  });

  it("status check reads the account without sending a prompt", async () => {
    const a = fakeSdk(MAX, []);
    const ok = await checkClaudeRuntime({ queryFn: a.queryFn, sourceEnv: { ANTHROPIC_API_KEY: "sk-secret" } });
    expect(ok).toMatchObject({ ok: true, state: "ready", observed: "subscription", plan: "max", overrides: ["ANTHROPIC_API_KEY"] });
    expect(JSON.stringify(ok)).not.toContain("sk-secret");
    expect(a.seen.prompts).toEqual([]);
    const out = await checkClaudeRuntime({ queryFn: fakeSdk({}, []).queryFn, sourceEnv: {} });
    expect(out).toMatchObject({ ok: false, state: "login_required" });
    const api = await checkClaudeRuntime({ queryFn: fakeSdk({ subscriptionType: "Claude API" }, []).queryFn, sourceEnv: {} });
    expect(api).toMatchObject({ ok: false, state: "billing_mismatch", observed: "api_key" });
    const missing = await checkClaudeRuntime({ queryFn: fakeSdk(new Error("spawn claude ENOENT"), []).queryFn, sourceEnv: {} });
    expect(missing).toMatchObject({ ok: false, state: "unavailable" });
  });

  it("classifies accounts conservatively", () => {
    expect(classifyAccount({ subscriptionType: "max" }).observed).toBe("subscription");
    expect(classifyAccount({ subscriptionType: "pro" }).observed).toBe("subscription");
    expect(classifyAccount({ subscriptionType: "max", apiKeySource: "ANTHROPIC_API_KEY" }).observed).toBe("api_key");
    expect(classifyAccount({ apiProvider: "bedrock" }).observed).toBe("third_party");
    expect(classifyAccount({ subscriptionType: "something" }).observed).toBe("unknown");
    expect(classifyAccount({}).observed).toBe("signed_out");
  });

  it("detects overrides by name only and renders repair rounds as one prompt", () => {
    expect(detectBillingOverrides({ ANTHROPIC_API_KEY: "x", ANTHROPIC_AUTH_TOKEN: "", PATH: "/bin" })).toEqual(["ANTHROPIC_API_KEY"]);
    expect(runtimeEnv({ ANTHROPIC_AUTH_TOKEN: "t", PATH: "/bin" })).toEqual({ PATH: "/bin", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    const p = renderTurns([
      { role: "user", content: "A" },
      { role: "assistant", content: "{}" },
      { role: "user", content: "fix" },
    ]);
    expect(p).toBe("<request>\nA\n</request>\n\n<your_previous_response>\n{}\n</your_previous_response>\n\n<follow_up>\nfix\n</follow_up>");
  });
});
