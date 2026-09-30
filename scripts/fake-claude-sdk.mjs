/**
 * TEST DOUBLE for the Claude Agent SDK boundary (never used in production: the studio ignores
 * STUDIO_CLAUDE_SDK_DOUBLE when NODE_ENV=production). It exports the same `query()` shape and
 * behaves according to a scenario file, so e2e tests can exercise the subscription runtime's
 * sign-in, usage-limit pause/resume and scoped-tooling paths without any Claude account.
 *
 *   STUDIO_CLAUDE_SDK_DOUBLE=scripts/fake-claude-sdk.mjs
 *   STUDIO_CLAUDE_SDK_DOUBLE_STATE=data/fake-claude.json   {"scenario": "signed_out" | "api_key" | "max" | "max_limit"}
 *
 * Every call is appended to <state>.log.jsonl (options summary + env variable NAMES, no values).
 */
import { appendFileSync, readFileSync } from "node:fs";

const stateFile = process.env.STUDIO_CLAUDE_SDK_DOUBLE_STATE ?? "data/fake-claude.json";
const scenario = () => {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")).scenario ?? "signed_out";
  } catch {
    return "signed_out";
  }
};
const ACCOUNTS = { signed_out: {}, api_key: { subscriptionType: "Claude API", apiProvider: "firstParty" }, max: { subscriptionType: "max", apiProvider: "firstParty" }, max_limit: { subscriptionType: "max", apiProvider: "firstParty" } };

export function query({ prompt, options = {} }) {
  const sc = scenario();
  const log = (event, extra = {}) =>
    appendFileSync(
      `${stateFile}.log.jsonl`,
      JSON.stringify({ at: new Date().toISOString(), event, scenario: sc, tools: options.tools, allowedTools: options.allowedTools, settingSources: options.settingSources, persistSession: options.persistSession, permissionMode: options.permissionMode, strictMcpConfig: options.strictMcpConfig, cwd: options.cwd, envNames: Object.keys(options.env ?? {}).sort(), outputFormat: options.outputFormat?.type ?? null, ...extra }) + "\n",
    );
  log("start");
  const gen = (async function* () {
    let text = "";
    if (typeof prompt === "string") text = prompt;
    else for await (const m of prompt) { text = String(m.message.content); break; }
    log("prompt", { promptChars: text.length });
    const model = options.model ?? "claude-opus-5-5";
    yield { type: "system", subtype: "init", model, apiKeySource: "none", tools: ["StructuredOutput"], cwd: options.cwd };
    const reset = Math.floor(Date.now() / 1000) + 2 * 3600;
    if (sc === "max_limit") {
      yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: reset } };
      yield { type: "assistant", error: "rate_limit", message: { model, content: [{ type: "text", text: "You've hit your limit" }] } };
      yield { type: "result", subtype: "success", is_error: true, result: "You've hit your limit", usage: {}, modelUsage: {} };
      return;
    }
    yield { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.31, resetsAt: reset } };
    const props = options.outputFormat?.schema?.properties ?? {};
    let out;
    if ("operations" in props) {
      const sceneId = /"(?:id|sceneId)"\s*:\s*"(scn_[A-Za-z0-9_-]+)"/.exec(text)?.[1] ?? /scn_[A-Za-z0-9_-]+/.exec(text)?.[0];
      out = { explanation: "TEST DOUBLE: set the first scene to 7 seconds.", clarificationQuestion: null, operations: sceneId ? [{ op: "setSceneDuration", sceneId, durationSec: 7 }] : [] };
    } else {
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["The test double only answers assistant edits."], usage: {}, modelUsage: {} };
      return;
    }
    yield { type: "result", subtype: "success", is_error: false, result: JSON.stringify(out), structured_output: out, usage: { input_tokens: Math.ceil(text.length / 4), output_tokens: 60, cache_read_input_tokens: 0 }, modelUsage: { [model]: {} } };
  })();
  return Object.assign(gen, {
    accountInfo: async () => {
      log("accountInfo");
      return ACCOUNTS[sc] ?? {};
    },
    close: () => {},
  });
}
