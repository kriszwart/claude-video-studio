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
  const request = String(grab("owner_request") ?? "");
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
    scriptStyle: settings.scriptStyle && settings.scriptStyle !== "auto" ? settings.scriptStyle : "professor",
    textInputs,
    assetInputs,
    rationale: "TEST DOUBLE: canned composer answer.",
    warnings: [],
  };
}

/** Recipe steps from a planner/scriptwriter prompt: "slot — purpose (~Ns, layout L…)". */
function recipeSteps(text) {
  const line = /Recipe(?: beats)? \(in order\): (.*)/.exec(text)?.[1] ?? "";
  return line.split("; ").map((part) => {
    const m = /^(\S+) — (.*?) \(~([\d.]+)s(.*)\)$/.exec(part.trim());
    return m ? { slot: m[1], purpose: m[2], sec: Number(m[3]), layout: /layout ([\w-]+)/.exec(m[4])?.[1], conditional: /only if/.test(m[4]) } : null;
  }).filter(Boolean);
}

/**
 * Script answer. The first draft deliberately contains stock phrasing ("Let's dive in") so the
 * studio's check-and-repair loop is exercised; the revision removes it.
 */
function scriptAnswer(text) {
  const narrated = /narrated="true"/.test(text);
  const target = Number(/targetDurationSec="([\d.]+)"/.exec(text)?.[1] ?? 20);
  const steps = recipeSteps(text).filter((s) => !s.conditional);
  const sum = steps.reduce((a, s) => a + s.sec, 0) || 1;
  const revising = /Revise the script/.test(text);
  const beats = steps.map((s, i) => ({
    recipeSlot: s.slot,
    purpose: s.purpose,
    narration: narrated ? `${i === 0 && !revising ? "Let's dive in. " : ""}This beat covers ${s.purpose.toLowerCase().replace(/[^a-z ]/g, "")} in plain words.` : "",
    onScreen: s.purpose.replace(/[0-9]/g, ""),
    durationSec: Math.max(1, Math.round((s.sec / sum) * target * 10) / 10),
    direction: i === 0 && narrated ? { pace: "slower", energy: "calm", note: "let the first line land" } : { pace: "normal", energy: "neutral", note: "" },
  }));
  return { beats, notes: "TEST DOUBLE: canned script, one beat per recipe step." };
}

/** Plan answer: follows an approved script exactly (one scene per beat), otherwise the recipe. */
function planAnswer(text) {
  const catalogue = (() => {
    try {
      return JSON.parse(/<layout_catalogue>([\s\S]*?)<\/layout_catalogue>/.exec(text)?.[1] ?? "{}");
    } catch {
      return {};
    }
  })();
  const steps = recipeSteps(text);
  const scriptJson = /<approved_script[^>]*>([\s\S]*?)<\/approved_script>/.exec(text)?.[1];
  const beats = scriptJson ? JSON.parse(scriptJson) : steps.filter((s) => !s.conditional).map((s) => ({ recipeSlot: s.slot, purpose: s.purpose, narration: "", onScreen: s.purpose, durationSec: s.sec }));
  const scenes = beats.map((b, i) => {
    const layout = steps.find((s) => s.slot === b.recipeSlot)?.layout ?? Object.keys(catalogue)[0];
    const slots = (catalogue[layout] ?? []).map((x) => x.replace(/ \(full frame\)$/, ""));
    const textSlot = slots.find((x) => x === "headline") ?? slots.find((x) => !/^media|presenter/.test(x));
    return {
      recipeSlot: b.recipeSlot,
      purpose: b.purpose,
      layout,
      durationSec: b.durationSec,
      transition: i === 0 ? "cut" : "fade",
      motionIntensity: 0.6,
      narration: b.narration,
      texts: textSlot && b.onScreen ? [{ slot: textSlot, role: "headline", text: b.onScreen, approvedFactId: null }] : [],
      media: [],
    };
  });
  return { rationale: "TEST DOUBLE: canned plan.", scenes, omitted: [], warnings: [] };
}

/** Critic answer: one fixable finding on scene 1 (with its frame), one note that needs the owner. */
function criticAnswer(text, images) {
  const frames = (() => {
    try {
      return JSON.parse(/<frames>([\s\S]*?)<\/frames>/.exec(text)?.[1] ?? "[]");
    } catch {
      return [];
    }
  })();
  const f1 = frames.find((f) => f.scene === 1);
  const contrast = (() => {
    try {
      return JSON.parse(/<contrast>([\s\S]*?)<\/contrast>/.exec(text)?.[1] ?? "[]");
    } catch {
      return [];
    }
  })();
  const locked = /"scene":1,[^}]*"locked":true/.test(/<scenes>([\s\S]*?)<\/scenes>/.exec(text)?.[1] ?? "");
  return {
    summary: `TEST DOUBLE: canned review of ${images} frame(s).`,
    scores: { story: 3, visuals: 3, readability: 2, pacing: 4 },
    strengths: ["TEST DOUBLE: consistent colour across shots."],
    findings: [
      { scene: 1, frame: f1?.image ?? 0, category: "readability", severity: "fix", observation: "TEST DOUBLE: the opening line is on screen too briefly.", suggestion: "Hold the opening shot longer.", request: locked ? "" : "Make this scene 7 seconds long." },
      { scene: 0, frame: 0, category: "story", severity: "nit", observation: "TEST DOUBLE: no product footage.", suggestion: "Add real product footage.", request: "" },
      ...contrast.map((c) => ({ scene: c.scene, frame: c.image ?? 0, category: "readability", severity: c.ratio < 2 ? "fix" : "improve", observation: `TEST DOUBLE: “${c.text}” measures ${c.ratio}:1 against ${c.background}.`, suggestion: "Use white text.", request: `Change the colour of the text “${c.text}” to #ffffff.` })),
    ],
  };
}

/** Product check: a mismatch (garbled logo) when the shot prompt asks for one, otherwise a match. */
function fidelityAnswer(text, images) {
  const bad = /TEST-MISMATCH/.test(text);
  const ok = (aspect) => ({ aspect, result: "ok", note: "" });
  return {
    verdict: bad ? "mismatch" : "match",
    summary: bad ? `TEST DOUBLE: the logo is garbled compared with the reference (${images} images).` : `TEST DOUBLE: same product as the reference (${images} images).`,
    checks: [ok("shape"), bad ? { aspect: "logo", result: "wrong", note: "TEST DOUBLE: letters are scrambled and the mark sits lower." } : ok("logo"), { aspect: "label", result: "unclear", note: "TEST DOUBLE: too small to read." }, ok("colour"), ok("proportions"), ok("details")],
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
    let images = 0;
    if (typeof prompt === "string") text = prompt;
    else
      for await (const m of prompt) {
        const c = m.message.content;
        if (Array.isArray(c)) {
          text = c.filter((b) => b.type === "text").map((b) => b.text).join("\n");
          images = c.filter((b) => b.type === "image" && b.source?.type === "base64" && b.source.data?.length > 100).length;
        } else text = String(c);
        break;
      }
    log("prompt", { promptChars: text.length, images });
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
    } else if ("verdict" in props && "checks" in props) {
      out = fidelityAnswer(text, images);
    } else if ("findings" in props && "scores" in props) {
      out = criticAnswer(text, images);
    } else if ("beats" in props && "notes" in props) {
      out = scriptAnswer(text);
    } else if ("scenes" in props && "rationale" in props) {
      out = planAnswer(text);
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
