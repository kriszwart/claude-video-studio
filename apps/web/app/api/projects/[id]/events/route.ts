import { and, eq, gt } from "drizzle-orm";
import { getDb, getProject, schema } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Server-sent job/project events, sourced from persisted job_events (DB is authoritative). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let s;
  const { id } = await ctx.params;
  try {
    s = await requireSession();
    await getProject(getDb(), id, s.workspaceId);
  } catch (e) {
    return errorResponse(e);
  }
  const workspaceId = s.workspaceId;
  const since = Number(new URL(req.url).searchParams.get("since") ?? req.headers.get("last-event-id") ?? 0);
  const enc = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      let last = Number.isFinite(since) ? since : 0;
      let lastRevision = "";
      const send = (event: string, data: unknown, id?: number) => controller.enqueue(enc.encode(`${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      if (last === 0) {
        const newest = await getDb().query.jobEvents.findFirst({ where: eq(schema.jobEvents.projectId, id), orderBy: (e, { desc }) => desc(e.id) });
        last = newest?.id ?? 0;
      }
      req.signal.addEventListener("abort", () => (closed = true));
      while (!closed) {
        try {
          const rows = await getDb().query.jobEvents.findMany({ where: and(eq(schema.jobEvents.projectId, id), eq(schema.jobEvents.workspaceId, workspaceId), gt(schema.jobEvents.id, last)), orderBy: (e, { asc }) => asc(e.id), limit: 100 });
          for (const r of rows) {
            last = r.id;
            send("job", { jobId: r.jobId, kind: r.kind, data: r.data, at: r.createdAt }, r.id);
          }
          const p = await getDb().query.projects.findFirst({ where: eq(schema.projects.id, id), columns: { currentRevisionId: true } });
          if (p?.currentRevisionId && p.currentRevisionId !== lastRevision) {
            lastRevision = p.currentRevisionId;
            send("revision", { revisionId: lastRevision });
          }
          send("ping", { t: Date.now() });
        } catch {
          closed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 700));
      }
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
}
