import { and, eq, inArray, sql } from "drizzle-orm";
import { enqueueJob, getDb, schema, verifyWebhookToken } from "@vs/db";
import { verifyFalWebhook, type Jwk } from "@vs/providers";

export const dynamic = "force-dynamic";

let jwksCache: { at: number; keys: Jwk[] } | null = null;
async function falJwks(): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.at < 6 * 3600_000) return jwksCache.keys;
  const r = await fetch(process.env.FAL_JWKS_URL ?? "https://rest.alpha.fal.ai/.well-known/jwks.json", { cache: "no-store" });
  const j = (await r.json()) as { keys?: Jwk[] };
  jwksCache = { at: Date.now(), keys: j.keys ?? [] };
  return jwksCache.keys;
}

const ok = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * fal completion webhook (§12). Authenticity: our per-request URL token (always) and fal's
 * Ed25519 signature (unless FAL_WEBHOOK_SIGNATURE=off for local fixtures). Events are
 * deduplicated by request id + status and are order-tolerant: a terminal state is never
 * overwritten, and a result for a canceled request is kept for recovery only.
 */
export async function POST(req: Request) {
  const u = new URL(req.url);
  const genId = u.searchParams.get("g") ?? "";
  const token = u.searchParams.get("t") ?? "";
  if (!genId || !verifyWebhookToken("fal", genId, token)) return ok({ error: "unauthorized" }, 401);
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.length > 5 * 1024 * 1024) return ok({ error: "too large" }, 413);
  if (process.env.FAL_WEBHOOK_SIGNATURE !== "off") {
    const h = Object.fromEntries([...req.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
    const v = verifyFalWebhook(h, raw, await falJwks().catch(() => []));
    if (!v.ok) return ok({ error: `signature: ${v.reason}` }, 401);
  }
  let body: { status?: string; request_id?: string; payload?: unknown; error?: string };
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return ok({ error: "invalid json" }, 400);
  }
  const db = getDb();
  const g = await db.query.generationRequests.findFirst({ where: eq(schema.generationRequests.id, genId) });
  if (!g) return ok({ ignored: "unknown request" });
  if (body.request_id && g.requestId && body.request_id !== g.requestId) return ok({ error: "request id mismatch" }, 409);
  const status = body.status === "OK" ? "OK" : "ERROR";
  const inserted = await db
    .insert(schema.providerEvents)
    .values({ provider: "fal", eventKey: `${body.request_id ?? g.requestId}:${status}`, requestId: body.request_id ?? g.requestId, payload: body as object })
    .onConflictDoNothing()
    .returning({ id: schema.providerEvents.id });
  if (!inserted.length) return ok({ duplicate: true });
  if (g.state === "canceled") {
    if (status === "OK") {
      await db.update(schema.generationRequests).set({ output: body as object, updatedAt: sql`now()` }).where(eq(schema.generationRequests.id, g.id));
      await db.transaction((tx) => enqueueJob(tx, { workspaceId: g.workspaceId, projectId: g.projectId, revisionId: null, type: "recover_generation", input: { generationId: g.id }, idempotencyKey: `recover:${g.id}` }));
    }
    return ok({ recovered: status === "OK" });
  }
  // Only non-terminal requests move; late or out-of-order events can't undo a result.
  await db
    .update(schema.generationRequests)
    .set(status === "OK" ? { state: "succeeded", output: body as object, updatedAt: sql`now()` } : { state: "failed", error: { message: String(body.error ?? "fal reported an error.").slice(0, 300) }, updatedAt: sql`now()` })
    .where(and(eq(schema.generationRequests.id, g.id), inArray(schema.generationRequests.state, ["submitting", "submitted", "uncertain"])));
  await db.update(schema.providerEvents).set({ processedAt: sql`now()` }).where(eq(schema.providerEvents.id, inserted[0]!.id));
  return ok({ accepted: true });
}
