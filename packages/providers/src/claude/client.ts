import Anthropic from "@anthropic-ai/sdk";

/** Central Claude configuration. Model IDs are configured here, never scattered through code. */
export const CLAUDE_CONFIG = {
  model: process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
  effort: (process.env.CLAUDE_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max",
  /** Server-side refusal fallbacks ("default" routing) on the Claude API. */
  fallbacks: process.env.CLAUDE_FALLBACKS !== "off",
  maxTokens: Number(process.env.CLAUDE_MAX_TOKENS ?? 32000),
};

export class ProviderError extends Error {
  constructor(
    public code: "credentials_missing" | "provider_auth" | "rate_limited" | "provider_unavailable" | "invalid_output" | "refused" | "bad_request" | "network",
    message: string,
    public retryable: boolean,
    public recovery?: string,
  ) {
    super(message);
  }
}

export function claudeClient(apiKey: string | undefined): Anthropic {
  if (!apiKey) {
    throw new ProviderError("credentials_missing", "Claude is not configured, so AI planning and assistant edits are unavailable.", false, "Add an Anthropic API key in Settings → Providers (or set ANTHROPIC_API_KEY on the server). Manual editing and rendering still work.");
  }
  // Explicit key only: the app never picks up ambient CLI credentials.
  return new Anthropic({ apiKey, baseURL: process.env.STUDIO_ANTHROPIC_BASE_URL || "https://api.anthropic.com", maxRetries: 2, timeout: 10 * 60_000 });
}

export function classifyClaudeError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError("provider_auth", "The Anthropic API rejected the configured key.", false, "Check or rotate the key in Settings → Providers.");
  }
  if (e instanceof Anthropic.RateLimitError) return new ProviderError("rate_limited", "Claude is rate-limited right now.", true);
  if (e instanceof Anthropic.BadRequestError) return new ProviderError("bad_request", `Claude rejected the request: ${e.message}`, false);
  if (e instanceof Anthropic.InternalServerError) return new ProviderError("provider_unavailable", "Claude is temporarily unavailable.", true);
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError("network", "Could not reach the Anthropic API.", true, "Check the server's network access to api.anthropic.com.");
  if (e instanceof Anthropic.APIError) return new ProviderError("provider_unavailable", `Anthropic API error ${e.status}`, (e.status ?? 500) >= 500);
  return new ProviderError("provider_unavailable", e instanceof Error ? e.message : String(e), true);
}

export interface StructuredCall {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  schema: Record<string, unknown>;
  maxTokens?: number;
  effort?: CLAUDE_EFFORT;
  signal?: AbortSignal;
}
type CLAUDE_EFFORT = (typeof CLAUDE_CONFIG)["effort"];

export interface StructuredResult {
  json: unknown;
  message: Anthropic.Beta.BetaMessage;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; model: string };
}

/**
 * One structured-output request. Streams (long outputs), constrains the response to the
 * JSON schema, and surfaces refusals / truncation as typed errors.
 */
export async function callStructured(client: Anthropic, call: StructuredCall): Promise<StructuredResult> {
  try {
    const stream = client.beta.messages.stream(
      {
        model: CLAUDE_CONFIG.model,
        max_tokens: call.maxTokens ?? CLAUDE_CONFIG.maxTokens,
        ...(CLAUDE_CONFIG.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        system: [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }],
        messages: call.messages,
        output_config: { effort: call.effort ?? CLAUDE_CONFIG.effort, format: { type: "json_schema", schema: call.schema } },
      },
      { signal: call.signal },
    );
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      throw new ProviderError("refused", "Claude declined this request.", false, "Rephrase the brief or request.");
    }
    if (message.stop_reason === "max_tokens") {
      throw new ProviderError("invalid_output", "Claude's response was cut off before it finished.", true);
    }
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderError("invalid_output", "Claude returned malformed JSON.", true);
    }
    return {
      json,
      message,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        model: message.model,
      },
    };
  } catch (e) {
    throw classifyClaudeError(e);
  }
}

/** Cheap live credential check for Settings. */
export async function checkClaude(apiKey: string): Promise<{ ok: boolean; message: string; model: string }> {
  try {
    const client = claudeClient(apiKey);
    const m = await client.models.retrieve(CLAUDE_CONFIG.model);
    return { ok: true, message: `Connected; ${m.display_name} is available.`, model: m.id };
  } catch (e) {
    const pe = classifyClaudeError(e);
    return { ok: false, message: pe.message, model: CLAUDE_CONFIG.model };
  }
}

/** Approximate list prices (USD per million tokens) for usage estimates; see docs for current pricing. */
export const CLAUDE_PRICES: Record<string, { input: number; output: number; asOf: string }> = {
  "claude-opus-5-5": { input: 4, output: 20, asOf: "2026-09-25" },
  "claude-sonnet-5-5": { input: 2, output: 10, asOf: "2026-09-25" },
  "claude-fable-5-1": { input: 10, output: 50, asOf: "2026-09-25" },
  "claude-haiku-4-5": { input: 1, output: 5, asOf: "2026-09-25" },
};

export function estimateClaudeCostMicros(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = CLAUDE_PRICES[model];
  if (!p) return null;
  return Math.round(inputTokens * p.input + outputTokens * p.output);
}
