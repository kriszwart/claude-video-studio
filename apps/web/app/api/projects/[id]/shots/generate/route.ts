import { z } from "zod";
import { and, eq, like, sql } from "drizzle-orm";
import { AppError, applyProjectOperations, enqueueJob, getDb, getProject, schema } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { serializeJob } from "@/lib/server/serialize";

/**
 * Enqueue generation for shots that still need footage. Accepted and supplied shots are
 * skipped (A13); `regenerate` creates a new, separately billed variant for the named shots.
 * Each job re-checks the budget before spending (the authoritative check); billing is
 * deduplicated per shot variant in the worker, so a repeated request can't double-bill.
 */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const idem = idempotencyKey(req);
  const b = await body(req, z.object({ sceneIds: z.array(z.string().max(64)).max(60).optional(), regenerate: z.boolean().default(false), mode: z.enum(["shots", "keyframes"]).default("shots") }));
  const db = getDb();
  const { project, revision, doc } = await getProject(db, id, s.workspaceId);
  if (doc.acquisitionPolicy !== "generated-allowed") throw new AppError(409, "generation_not_allowed", "This project's asset policy doesn't allow generated media.", "Supply your own footage, or allow generated media (within the budget) in the Shots panel.");
  if (b.mode === "keyframes") {
    // Keyframes: one image per video shot still without footage (animatic first).
    const kfTargets = doc.scenes.filter((sc) => sc.shot && sc.shot.kind === "video" && sc.shot.source === "generate" && !sc.shot.acceptedAssetId && (!b.sceneIds || b.sceneIds.includes(sc.id)) && (b.regenerate ? !!b.sceneIds : !sc.shot.keyframeAssetId));
    const jobs = await db.transaction(async (tx) => {
      const out = [];
      for (const sc of kfTargets) {
        // Each keyframe request is its own billed operation: count earlier ones for this shot.
        const prior = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.generationRequests).where(and(eq(schema.generationRequests.workspaceId, s.workspaceId), like(schema.generationRequests.operationId, `${project.id}:${sc.id}:kf%`)));
        const attempt = b.regenerate ? (prior[0]?.n ?? 0) + 1 : Math.max(1, prior[0]?.n ?? 0);
        out.push((await enqueueJob(tx, { workspaceId: s.workspaceId, projectId: project.id, revisionId: revision.id, type: "generate_media", input: { sceneId: sc.id, mode: "keyframe", variant: attempt }, idempotencyKey: idem ? `kf:${idem}:${sc.id}` : null })).job);
      }
      return out;
    });
    return json({ jobs: jobs.map(serializeJob), skipped: [] }, 202);
  }
  const targets = doc.scenes.filter((sc) => sc.shot && sc.shot.source === "generate" && (!b.sceneIds || b.sceneIds.includes(sc.id)) && (b.regenerate ? !!b.sceneIds : sc.shot.status !== "accepted" && sc.shot.status !== "generating"));
  // The animatic gate: once keyframes exist, video waits for the owner's approval.
  if (doc.animatic?.status === "pending" && targets.some((sc) => sc.shot!.kind === "video")) {
    throw new AppError(409, "animatic_not_approved", "Approve the animatic before generating video.", "Render the animatic from the keyframes, review it, then approve it.");
  }
  const jobs = await db.transaction(async (tx) => {
    let base = revision.id;
    if (b.regenerate && targets.length) {
      const r = await applyProjectOperations(tx, { projectId: project.id, workspaceId: s.workspaceId, baseRevisionId: base, ops: targets.map((sc) => ({ op: "setShotStatus" as const, sceneId: sc.id, status: sc.shot!.status === "accepted" ? ("accepted" as const) : ("pending" as const), variant: sc.shot!.variant + 1 })), actor: "user", action: "regenerate shots" });
      base = r.revision.id;
    }
    const out = [];
    for (const sc of targets) {
      const variant = b.regenerate ? sc.shot!.variant + 1 : sc.shot!.variant;
      out.push((await enqueueJob(tx, { workspaceId: s.workspaceId, projectId: project.id, revisionId: base, type: "generate_media", input: { sceneId: sc.id, variant }, idempotencyKey: idem ? `gen:${idem}:${sc.id}` : null })).job);
    }
    return out;
  });
  return json({ jobs: jobs.map(serializeJob), skipped: doc.scenes.filter((sc) => sc.shot && !targets.includes(sc)).map((sc) => ({ sceneId: sc.id, reason: sc.shot!.source === "supplied" ? "supplied footage" : sc.shot!.status })) }, 202);
});
