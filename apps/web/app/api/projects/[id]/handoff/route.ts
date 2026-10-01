import { z } from "zod";
import { applyProjectOperations, getDb, getProject } from "@vs/db";
import { Operation } from "@vs/domain";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";

/**
 * Claude Code project-file handoff (PRD §28): when the integrated runtime is unavailable, the
 * owner can export the project, ask Claude Code in their own terminal for a change, and import
 * the typed operations it wrote. The studio never runs anything in this path; imported
 * operations are validated like assistant edits (base revision, locks, approved claims, mode).
 */
const INSTRUCTIONS = `# Fluxtify — Claude Code handoff

This file is a snapshot of one project revision. To make an AI edit with Claude Code:

1. Put this file in an empty folder and run \`claude\` there (signed in with your Claude plan).
2. Describe the change you want, and ask Claude to write \`operations.json\` next to this file:
   \`{ "baseRevisionId": "<baseRevisionId from this file>", "ops": [ ...operations ] }\`
   Each operation must match \`operationSchema\` below. Do not rewrite \`document\` itself.
3. In the studio, open the project's Assistant tab and choose "Import operations file".

Rules the studio enforces on import: the project must still be at \`baseRevisionId\` (otherwise
export again), locked scenes and approved claims cannot change, strict creative mode applies,
and only asset ids listed in \`document\` may be referenced. Keep claims to the approved facts in
\`document.brief\`.`;

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const { project, revision, doc } = await getProject(getDb(), id, s.workspaceId);
  const bundle = {
    format: "claude-video-studio.handoff/1",
    instructions: INSTRUCTIONS,
    projectId: project.id,
    title: project.title,
    baseRevisionId: revision.id,
    exportedAt: new Date().toISOString(),
    document: doc,
    operationSchema: z.toJSONSchema(Operation, { unrepresentable: "any", io: "input" }),
  };
  return new Response(JSON.stringify(bundle, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="claude-code-handoff-${project.id}.json"`,
      "Cache-Control": "no-store",
    },
  });
});

const Import = z.object({ baseRevisionId: z.string().max(64), ops: z.array(Operation).min(1).max(200) });

export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, Import);
  const r = await getDb().transaction((tx) => applyProjectOperations(tx, { projectId: id, workspaceId: s.workspaceId, baseRevisionId: b.baseRevisionId, ops: b.ops, actor: "assistant", action: "Claude Code handoff import" }));
  return json({ revisionId: r.revision.id, changedSceneIds: r.changedSceneIds, noop: r.noop });
});
