import { z } from "zod";
import { applyProjectOperations, enqueueJob, getDb, getProject } from "@vs/db";
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
  const b = await body(req, z.object({ sceneIds: z.array(z.string().max(64)).max(60).optional(), regenerate: z.boolean().default(false) }));
  const db = getDb();
  const { project, revision, doc } = await getProject(db, id, s.workspaceId);
  const targets = doc.scenes.filter((sc) => sc.shot && sc.shot.source === "generate" && (!b.sceneIds || b.sceneIds.includes(sc.id)) && (b.regenerate ? !!b.sceneIds : sc.shot.status !== "accepted" && sc.shot.status !== "generating"));
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
