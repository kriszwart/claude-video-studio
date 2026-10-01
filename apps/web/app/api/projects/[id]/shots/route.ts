import { getDb, subscriptionRuntimeAllowed, getProject, getProviderSecret, getProviderSettings, projectLedger, projectTotals, signAssetUrl } from "@vs/db";
import { decideSpend, type BudgetPolicy } from "@vs/domain";
import { CODEX_PLAN_BASIS, CodexSettings, estimateFor, FalSettings, openRouterEstimate, OpenRouterSettings, pickImageProvider } from "@vs/providers";
import type { Estimate } from "@vs/domain";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";

/** Shot list with per-shot cost estimates, budget position and ledger (shown before any paid work). */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const db = getDb();
  const { project, doc } = await getProject(db, id, s.workspaceId);
  const settings = FalSettings.safeParse(await getProviderSettings(db, s.workspaceId, "fal"));
  const configured = !!(await getProviderSecret(db, s.workspaceId, "fal"));
  // Image shots go to OpenRouter when it has a key and an image model (and is preferred, or fal has none).
  const or = OpenRouterSettings.safeParse(await getProviderSettings(db, s.workspaceId, "openrouter"));
  const orReady = or.success && !!or.data.image && !!(await getProviderSecret(db, s.workspaceId, "openrouter"));
  const falImage = settings.success ? settings.data.image : undefined;
  const cx = CodexSettings.safeParse(await getProviderSettings(db, s.workspaceId, "codex"));
  const imageVia = pickImageProvider({ codex: cx.success ? cx.data : null, codexAllowed: subscriptionRuntimeAllowed(), openRouterReady: orReady, openRouterPreferred: or.success && or.data.preferForImages, falImage: configured && !!falImage });
  // ChatGPT-plan images cost no money, so they are outside the paid budget.
  const planEstimate: Estimate = { kind: "known", micros: 0, priceTimestamp: "plan", basis: CODEX_PLAN_BASIS };
  const totals = await projectTotals(db, id);
  const budget = project.budget as BudgetPolicy;
  let running = { ...totals };
  const shots = doc.scenes
    .filter((sc) => sc.shot)
    .map((sc, i) => {
      const viaCodex = sc.shot!.kind === "image" && imageVia === "codex";
      const viaOpenRouter = sc.shot!.kind === "image" && imageVia === "openrouter" && or.success;
      const model = settings.success ? settings.data[sc.shot!.kind] : undefined;
      const estimate = viaCodex ? planEstimate : viaOpenRouter ? openRouterEstimate(or.data) : estimateFor(model);
      const needsWork = sc.shot!.source === "generate" && sc.shot!.status !== "accepted" && !viaCodex;
      const decision = needsWork ? decideSpend(budget, running, estimate) : null;
      if (decision?.allowed) running = { committedMicros: running.committedMicros + (decision.reserveMicros ?? 0), unknownPriceRequestsUsed: running.unknownPriceRequestsUsed + (estimate.kind === "unknown" ? 1 : 0) };
      return { index: i + 1, sceneId: sc.id, purpose: sc.purpose, shot: sc.shot, estimate, model: viaCodex ? "ChatGPT (Codex CLI)" : viaOpenRouter ? or.data.image!.model : (model?.endpoint ?? null), provider: viaCodex ? "codex" : viaOpenRouter ? "openrouter" : "fal", fitsBudget: decision ? decision.allowed : null, budgetMessage: decision && !decision.allowed ? decision.message : null };
    });
  // Keyframes are image generations for video shots: priced like an image through the image provider.
  const keyframeEstimate = imageVia === "codex" ? planEstimate : imageVia === "openrouter" && or.success ? openRouterEstimate(or.data) : estimateFor(falImage);
  const keyframes = doc.scenes
    .filter((sc) => sc.shot?.kind === "video")
    .map((sc) => ({ sceneId: sc.id, needsKeyframe: sc.shot!.source === "generate" && !sc.shot!.acceptedAssetId, url: sc.shot!.keyframeAssetId ? signAssetUrl(sc.shot!.keyframeAssetId, s.workspaceId) : null }));
  return json({ animatic: doc.animatic ?? null, keyframeEstimate, keyframes, providerConfigured: configured || orReady || imageVia === "codex", imageVia, modelsConfigured: settings.success ? { image: !!settings.data.image || orReady || imageVia === "codex", video: !!settings.data.video } : { image: orReady || imageVia === "codex", video: false }, budget, totals, shots, ledger: await projectLedger(db, id) });
});
