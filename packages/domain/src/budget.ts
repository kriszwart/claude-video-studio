/**
 * Spend authorisation (FR-12). Amounts are integer micro-units of the currency
 * to avoid float drift. Unknown prices never count as free: they require an
 * explicit bounded authorisation of a number of requests.
 */
export interface BudgetPolicy {
  currency: "USD";
  /** Per-project ceiling, micro-USD. 0 means no paid work is authorised. */
  projectCeilingMicros: number;
  /** Per-operation ceiling, micro-USD. */
  operationCeilingMicros: number;
  /** Number of unknown-price requests the owner has explicitly authorised. */
  unknownPriceRequestsAuthorized: number;
}

export interface LedgerTotals {
  /** Reserved (in-flight) + actual (settled) spend, micro-USD. */
  committedMicros: number;
  unknownPriceRequestsUsed: number;
}

export type Estimate = { kind: "known"; micros: number; priceTimestamp: string; basis: string } | { kind: "unknown"; reason: string };

export type BudgetDecision =
  | { allowed: true; reserveMicros: number | null }
  | { allowed: false; code: "budget_exceeded" | "operation_ceiling" | "unknown_price_unauthorized" | "no_budget"; message: string };

export function decideSpend(policy: BudgetPolicy, totals: LedgerTotals, estimate: Estimate): BudgetDecision {
  if (estimate.kind === "unknown") {
    if (totals.unknownPriceRequestsUsed >= policy.unknownPriceRequestsAuthorized) {
      return {
        allowed: false,
        code: "unknown_price_unauthorized",
        message: `The price of this operation is unknown (${estimate.reason}). Authorise a bounded number of requests before continuing.`,
      };
    }
    return { allowed: true, reserveMicros: null };
  }
  if (policy.projectCeilingMicros <= 0) {
    return { allowed: false, code: "no_budget", message: "No paid-generation budget is authorised for this project." };
  }
  if (estimate.micros > policy.operationCeilingMicros) {
    return { allowed: false, code: "operation_ceiling", message: `Estimated ${fmt(estimate.micros)} exceeds the per-operation ceiling of ${fmt(policy.operationCeilingMicros)}.` };
  }
  if (totals.committedMicros + estimate.micros > policy.projectCeilingMicros) {
    return {
      allowed: false,
      code: "budget_exceeded",
      message: `Estimated ${fmt(estimate.micros)} would exceed the project budget (${fmt(policy.projectCeilingMicros - totals.committedMicros)} remaining).`,
    };
  }
  return { allowed: true, reserveMicros: estimate.micros };
}

export function fmt(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 4 : 2)}`;
}

export const DEFAULT_BUDGET: BudgetPolicy = { currency: "USD", projectCeilingMicros: 0, operationCeilingMicros: 0, unknownPriceRequestsAuthorized: 0 };
