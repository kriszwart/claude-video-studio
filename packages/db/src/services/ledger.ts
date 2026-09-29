import { and, eq, sql } from "drizzle-orm";
import { decideSpend, type BudgetDecision, type BudgetPolicy, type Estimate, type LedgerTotals } from "@vs/domain";
import type { DbOrTx } from "../client";
import { newId } from "../ids";
import { projects, usageLedger } from "../schema";

/**
 * Spend ledger (FR-12, A08, A09). One row per logical operation (unique per workspace);
 * duplicate events or retries resolve to the same row, so totals stay consistent.
 * Committed spend = reserved (in flight) + settled actuals; released rows don't count.
 */
export async function projectTotals(db: DbOrTx, projectId: string): Promise<LedgerTotals> {
  const r = await db.execute(sql`
    select
      coalesce(sum(case when status = 'reserved' then coalesce(reserved_micros, 0) when status = 'settled' then coalesce(actual_micros, estimated_micros, 0) else 0 end), 0)::bigint as committed,
      count(*) filter (where status = 'unknown_price' or (status = 'settled' and estimated_micros is null and actual_micros is null))::int as unknown_used
    from usage_ledger where project_id = ${projectId} and capability in ('image-generation', 'video-generation')`);
  const row = r.rows[0] as { committed: string | number; unknown_used: number };
  return { committedMicros: Number(row.committed), unknownPriceRequestsUsed: Number(row.unknown_used) };
}

/**
 * Authorise and reserve spend for one operation atomically (the project row is locked so
 * concurrent shots can't both squeeze under the ceiling). Idempotent per operationId.
 */
export async function reserveSpend(
  tx: DbOrTx,
  input: { workspaceId: string; projectId: string; jobId: string; operationId: string; provider: string; capability: string; estimate: Estimate },
): Promise<{ decision: BudgetDecision; ledgerId: string | null; existing: boolean }> {
  await tx.execute(sql`select id from projects where id = ${input.projectId} for update`);
  const prior = await tx.query.usageLedger.findFirst({ where: and(eq(usageLedger.workspaceId, input.workspaceId), eq(usageLedger.operationId, input.operationId)) });
  if (prior && prior.status !== "released") return { decision: { allowed: true, reserveMicros: prior.reservedMicros ?? null }, ledgerId: prior.id, existing: true };
  const project = await tx.query.projects.findFirst({ where: eq(projects.id, input.projectId) });
  const policy = project!.budget as BudgetPolicy;
  const totals = await projectTotals(tx, input.projectId);
  const decision = decideSpend(policy, totals, input.estimate);
  if (!decision.allowed) return { decision, ledgerId: null, existing: false };
  const values = {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    jobId: input.jobId,
    operationId: input.operationId,
    provider: input.provider,
    capability: input.capability,
    status: input.estimate.kind === "unknown" ? ("unknown_price" as const) : ("reserved" as const),
    estimatedMicros: input.estimate.kind === "known" ? input.estimate.micros : null,
    reservedMicros: decision.reserveMicros,
    actualMicros: null,
    priceTimestamp: input.estimate.kind === "known" ? input.estimate.priceTimestamp : null,
    priceBasis: input.estimate.kind === "known" ? input.estimate.basis : input.estimate.reason,
    updatedAt: sql`now()`,
  };
  if (prior) {
    await tx.update(usageLedger).set(values).where(eq(usageLedger.id, prior.id));
    return { decision, ledgerId: prior.id, existing: false };
  }
  const id = newId("use");
  await tx.insert(usageLedger).values({ id, ...values });
  return { decision, ledgerId: id, existing: false };
}

/** Settle at the actual (or, when the provider reports none, the estimated) amount. Idempotent. */
export async function settleSpend(db: DbOrTx, workspaceId: string, operationId: string, actualMicros: number | null) {
  await db
    .update(usageLedger)
    .set({ status: "settled", actualMicros: actualMicros ?? sql`${usageLedger.estimatedMicros}`, updatedAt: sql`now()` })
    .where(and(eq(usageLedger.workspaceId, workspaceId), eq(usageLedger.operationId, operationId), sql`${usageLedger.status} in ('reserved', 'unknown_price')`));
}

/** Release a reservation when the provider definitely did not bill (rejected before work). */
export async function releaseSpend(db: DbOrTx, workspaceId: string, operationId: string) {
  await db
    .update(usageLedger)
    .set({ status: "released", updatedAt: sql`now()` })
    .where(and(eq(usageLedger.workspaceId, workspaceId), eq(usageLedger.operationId, operationId), sql`${usageLedger.status} in ('reserved', 'unknown_price')`));
}

export async function projectLedger(db: DbOrTx, projectId: string) {
  return db.query.usageLedger.findMany({ where: eq(usageLedger.projectId, projectId), orderBy: (u, { asc }) => asc(u.createdAt) });
}
