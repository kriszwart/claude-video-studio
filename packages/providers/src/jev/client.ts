import { z } from "zod";

/**
 * Jev (TypeSafe's "System One" decision model): typed, fast decisions instead of prose.
 * One POST answers several named questions about the same state:
 *   choice — pick one of the given options (probability per option + confidence)
 *   score  — place on an ordered list of levels (probability-weighted score)
 *   noul   — probability that a statement is true
 * Used only for suggestions the owner can ignore; never for scripts, edits or anything paid.
 */

export const JevSettings = z.object({
  /** API address. The official API is TypeSafe's; a key from a Jev community hub may need its own address. */
  baseUrl: z.string().url().max(200).default("https://api.typesafe.ai"),
  model: z.string().max(80).default("jev-latest"),
});
export type JevSettings = z.infer<typeof JevSettings>;

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } };

export type JevAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence?: number }
  | { type: "noul"; probability: number };

export class JevError extends Error {
  constructor(
    public code: "auth" | "rate_limited" | "bad_request" | "unavailable" | "timeout" | "invalid_output",
    message: string,
  ) {
    super(message);
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class JevClient {
  readonly base: string;
  constructor(
    private key: string,
    private settings: JevSettings = JevSettings.parse({}),
    private fetchImpl: Fetch = fetch,
  ) {
    // Test seam: a local stand-in outside production only.
    const override = process.env.NODE_ENV !== "production" ? process.env.JEV_BASE_URL : undefined;
    this.base = (override ?? settings.baseUrl).replace(/\/$/, "");
  }

  async decide(state: unknown, questions: Record<string, JevQuestion>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ answers: Record<string, JevAnswer>; model: string | null; elapsedMs: number }> {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 4000);
    opts.signal?.addEventListener("abort", () => ctrl.abort());
    let r: Response;
    try {
      r = await this.fetchImpl(`${this.base}/v1/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.settings.model, state, questions }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new JevError(ctrl.signal.aborted ? "timeout" : "unavailable", ctrl.signal.aborted ? "Jev did not answer in time." : `Jev is unreachable: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await r.text();
    if (r.status === 401 || r.status === 403) throw new JevError("auth", "Jev rejected the API key.");
    if (r.status === 429) throw new JevError("rate_limited", "Jev is rate limiting requests (or the account is out of credits).");
    if (r.status >= 400 && r.status < 500) throw new JevError("bad_request", `Jev refused the request (${r.status}): ${text.slice(0, 200)}`);
    if (!r.ok) throw new JevError("unavailable", `Jev error ${r.status}.`);
    let j: { answers?: Record<string, JevAnswer>; result?: { answers?: Record<string, JevAnswer> }; model?: string };
    try {
      j = JSON.parse(text);
    } catch {
      throw new JevError("invalid_output", "Jev returned something that isn't JSON.");
    }
    // Documented as `answers`; some hubs wrap it in `result`.
    const answers = j.answers ?? j.result?.answers;
    if (!answers || typeof answers !== "object") throw new JevError("invalid_output", "Jev's answer had no answers.");
    return { answers, model: typeof j.model === "string" ? j.model : null, elapsedMs: Date.now() - t0 };
  }

  /** Live key check: one tiny noul question. */
  async check(): Promise<{ ok: boolean; message: string }> {
    try {
      const r = await this.decide("A key check from Fluxtify.", { ok: { type: "noul", instructions: "Is this a key check?" } }, { timeoutMs: 8000 });
      return { ok: true, message: `Jev answered in ${r.elapsedMs} ms${r.model ? ` (${r.model})` : ""}.` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** A choice answer only when it is valid and confident enough to show. */
export function confidentChoice(a: JevAnswer | undefined, allowed: string[], min = 0.45): { value: string; confidence: number } | null {
  if (!a || a.type !== "choice" || !allowed.includes(a.choice)) return null;
  const confidence = typeof a.confidence === "number" ? a.confidence : (a.probabilities?.[a.choice] ?? 0);
  return confidence >= min ? { value: a.choice, confidence } : null;
}
