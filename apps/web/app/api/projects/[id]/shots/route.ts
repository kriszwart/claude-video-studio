import { getDb, getProject, getProviderSecret, getProviderSettings, projectLedger, projectTotals } from "@vs/db";
import { decideSpend, type BudgetPolicy } from "@vs/domain";
import { estimateFor, FalSettings } from "@vs/providers";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";

/** Shot list with per-shot cost estimates, budget position and ledger (shown before any paid work). */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const db = getDb();
  const { project, doc } = await getProject(db, id, s.workspaceId);
  const settings = FalSettings.safeParse(await getProviderSettings(db, s.workspaceId, "fal"));
  const configured = !!(await getProviderSecret(db, s.workspaceId, "fal"));
  const totals = await projectTotals(db, id);
  const budget = project.budget as BudgetPolicy;
  let running = { ...totals };
  const shots = doc.scenes
    .filter((sc) => sc.shot)
    .map((sc, i) => {
      const model = settings.success ? settings.data[sc.shot!.kind] : undefined;
      const estimate = estimateFor(model);
      const needsWork = sc.shot!.source === "generate" && sc.shot!.status !== "accepted";
      const decision = needsWork ? decideSpend(budget, running, estimate) : null;
      if (decision?.allowed) running = { committedMicros: running.committedMicros + (decision.reserveMicros ?? 0), unknownPriceRequestsUsed: running.unknownPriceRequestsUsed + (estimate.kind === "unknown" ? 1 : 0) };
      return { index: i + 1, sceneId: sc.id, purpose: sc.purpose, shot: sc.shot, estimate, model: model?.endpoint ?? null, fitsBudget: decision ? decision.allowed : null, budgetMessage: decision && !decision.allowed ? decision.message : null };
    });
  return json({ providerConfigured: configured, modelsConfigured: settings.success ? { image: !!settings.data.image, video: !!settings.data.video } : { image: false, video: false }, budget, totals, shots, ledger: await projectLedger(db, id) });
});
