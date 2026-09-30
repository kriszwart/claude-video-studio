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

/**
 * Composer answer: deterministic and obviously canned. Picks the pinned (or first) template,
 * fills required text inputs with words from the request, uses attached media where the template
 * requires it, and never adds figures.
 */
function composeAnswer(text, props) {
  const grab = (tag) => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
    try {
      return m ? JSON.parse(m[1]) : null;
    } catch {
      return null;
    }
  };
  const templates = grab("templates") ?? [];
  const settings = grab("settings") ?? {};
  const attachments = grab("attachments") ?? [];
  const request = String(grab("request") ?? "");
  const allowed = props.templateId.enum ?? [];
  const t = templates.find((x) => allowed.includes(x.id) && x.id === "motion-reel") ?? templates.find((x) => allowed.includes(x.id)) ?? templates[0];
  const words = request.replace(/[0-9]/g, "").split(/\s+/).filter(Boolean);
  const phrase = (n, max) => (words.slice(0, n).join(" ") || "Untitled").slice(0, max ?? 60);
  const textInputs = [];
  const assetInputs = [];
  const kinds = { image: ["image", "svg"], images: ["image", "svg"], audio: ["audio"], video: ["video"], videos: ["video"] };
  for (const f of t.inputs) {
    if (kinds[f.kind]) {
      const a = attachments.find((x) => kinds[f.kind].includes(x.kind) && !assetInputs.some((ai) => ai.assetIds.includes(x.id)));
      if (a && (f.required || f.kind !== "audio" || settings.music !== "off")) assetInputs.push({ inputId: f.id, assetIds: [a.id] });
    } else if (f.required && f.kind !== "facts") {
      if (f.kind === "list") textInputs.push({ inputId: f.id, value: "", items: [phrase(3, 40)] });
      else if (f.kind === "select") textInputs.push({ inputId: f.id, value: f.options?.[0] ?? "", items: [] });
      else textInputs.push({ inputId: f.id, value: phrase(f.maxLength && f.maxLength < 45 ? 3 : 6, f.maxLength), items: [] });
    }
  }
  const aspect = settings.aspect && settings.aspect !== "auto" && t.aspects.includes(settings.aspect) ? settings.aspect : t.aspects[0];
  const want = typeof settings.durationSec === "number" ? settings.durationSec : t.durationSec.defaultSec;
  return {
    templateId: t.id,
    title: `TEST DOUBLE: ${phrase(5, 50)}`,
    aspect,
    durationSec: Math.min(t.durationSec.maxSec, Math.max(t.durationSec.minSec, want)),
    narration: settings.voice === "on" && t.narration !== "none",
    textInputs,
    assetInputs,
    rationale: "TEST DOUBLE: canned composer answer.",
    warnings: [],
  };
}

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
    } else if ("textInputs" in props && "templateId" in props) {
      out = composeAnswer(text, props);
    } else {
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["The test double only answers assistant edits and composer requests."], usage: {}, modelUsage: {} };
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
