import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError, applyProjectOperations, getDb, getProject, JobError } from "@vs/db";
import type { ClaudeFidelity, Operation } from "@vs/domain";
import { runFidelityCheck, type ClaudeEffort, type FidelityImage } from "@vs/providers";
import { FFMPEG, runOk } from "@vs/rendering";
import { resolveAssets, type Handler, type JobContext } from "../context";
import { claudeFor, noteLimit, recordUsage, toJobError } from "./ai";

const MAX_TAKES = 12;
const MAX_REFS = 3;
/** Claude isn't set up (or not signed in): an automatic check steps aside instead of failing. */
const NOT_SET_UP = new Set(["credentials_missing", "runtime_login_required", "runtime_unavailable", "billing_mode_mismatch"]);

/** One JPEG, at most 1024 px wide, from an image or from a video at a time. */
async function still(ctx: JobContext, src: string, name: string, atSec: number | null): Promise<FidelityImage> {
  const out = join(ctx.workDir, `${name}.jpg`);
  await runOk(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", ...(atSec !== null ? ["-ss", atSec.toFixed(2)] : []), "-i", src, "-vf", "scale='min(1024,iw)':-2", "-frames:v", "1", "-q:v", "3", out], { timeoutMs: 60_000 });
  return { mediaType: "image/jpeg", data: (await readFile(out)).toString("base64") };
}

/**
 * Product check (A23, beyond colour): Claude compares each generated take with the shot's
 * reference photos for shape, logo, label, colour and proportions, and the verdict is stored on
 * the take. Read-only otherwise: nothing is accepted, rejected or regenerated automatically.
 */
export const checkFidelity: Handler = async (ctx) => {
  const db = getDb();
  const projectId = ctx.job.projectId!;
  const input = ctx.job.input as { sceneIds?: string[]; assetId?: string; recheck?: boolean; auto?: boolean; effort?: ClaudeEffort };
  const { doc } = await getProject(db, projectId, ctx.job.workspaceId);
  const takes = doc.scenes.flatMap((s) =>
    s.shot && s.shot.referenceAssetIds.length && (!input.sceneIds?.length || input.sceneIds.includes(s.id))
      ? s.shot.candidates.filter((c) => (input.assetId ? c.assetId === input.assetId : c.review?.decision !== "rejected" && (input.recheck || !c.review?.claude))).map((c) => ({ scene: s, assetId: c.assetId }))
      : [],
  );
  if (!takes.length) {
    // An automatic check whose take was removed or already checked has nothing to do.
    if (input.auto) return { checked: 0, skipped: 0, mismatches: 0, results: [], note: "nothing to check" };
    throw new JobError("nothing_to_check", "No generated takes with a reference photo are waiting for a product check.", false, "Add the product photo as the shot's reference, generate a take, then check again.");
  }
  let client;
  try {
    client = await claudeFor(ctx.job.workspaceId, projectId);
  } catch (e) {
    // Automatic checks never fail a project for a missing Claude setup; the button still works once it's set up.
    if (input.auto && e instanceof JobError && NOT_SET_UP.has(e.code)) return { checked: 0, skipped: takes.length, mismatches: 0, results: [], note: e.message };
    throw e;
  }

  const results: { sceneId: string; assetId: string; verdict: ClaudeFidelity["verdict"] }[] = [];
  for (const [i, t] of takes.slice(0, MAX_TAKES).entries()) {
    await ctx.stage(`checking take ${i + 1} of ${Math.min(takes.length, MAX_TAKES)}`);
    const shot = t.scene.shot!;
    const refIds = shot.referenceAssetIds.slice(0, MAX_REFS);
    const files = await resolveAssets(ctx.job.workspaceId, [...refIds, t.assetId]);
    const references = await Promise.all(refIds.map((id, k) => still(ctx, files.get(id)!.path, `ref-${i}-${k}`, null)));
    const take = files.get(t.assetId)!;
    const dur = take.kind === "video" ? Number(take.media.durationSec ?? 0) : 0;
    const times = dur > 0 ? [dur * 0.2, dur * 0.5, dur * 0.8].map((x) => Math.round(x * 100) / 100) : [null];
    const frames = await Promise.all(times.map(async (at, k) => ({ ...(await still(ctx, take.path, `take-${i}-${k}`, at)), atSec: at })));
    const product = [shot.prompt, shot.continuity && `Continuity: ${shot.continuity}`, `Video: ${doc.title}`].filter(Boolean).join("\n");
    let run;
    try {
      run = await runFidelityCheck(client, { product, references, frames }, { signal: ctx.signal, effort: input.effort ?? "high" });
    } catch (e) {
      await noteLimit(ctx.job.workspaceId, e);
      const je = toJobError(e);
      if (input.auto && NOT_SET_UP.has(je.code)) return { checked: results.length, skipped: takes.length - results.length, mismatches: results.filter((r) => r.verdict === "mismatch").length, results, note: je.message };
      throw je;
    }
    await noteLimit(ctx.job.workspaceId, null, run.usage);
    await recordUsage(ctx.job.workspaceId, projectId, ctx.job.id, run.usage, "product-check");
    const claude: ClaudeFidelity = { ...run.output, frames: frames.length, model: run.usage.at(-1)?.model ?? null, checkedAt: new Date().toISOString() };
    await record(ctx, [{ op: "setShotFidelity", sceneId: t.scene.id, assetId: t.assetId, claude }], claude.verdict === "mismatch" ? "Claude flagged a product mismatch" : "Claude checked a take against the product");
    results.push({ sceneId: t.scene.id, assetId: t.assetId, verdict: claude.verdict });
  }
  return { checked: results.length, skipped: Math.max(0, takes.length - MAX_TAKES), mismatches: results.filter((r) => r.verdict === "mismatch").length, results };
};

async function record(ctx: JobContext, ops: Operation[], action: string) {
  const db = getDb();
  for (let attempt = 0; attempt < 4; attempt++) {
    const { revision, doc } = await getProject(db, ctx.job.projectId!, ctx.job.workspaceId);
    const live = ops.filter((o) => o.op !== "setShotFidelity" || doc.scenes.find((s) => s.id === o.sceneId)?.shot?.candidates.some((c) => c.assetId === o.assetId));
    if (!live.length) return; // the take was removed meanwhile
    try {
      await db.transaction((tx) => applyProjectOperations(tx, { projectId: ctx.job.projectId!, workspaceId: ctx.job.workspaceId, baseRevisionId: revision.id, ops: live, actor: "system", author: "system", action }));
      return;
    } catch (e) {
      if (!(e instanceof AppError && e.status === 409)) throw e;
    }
  }
  throw new JobError("stale_revision", "The project kept changing while the check was saved; run the check again.", false);
}
