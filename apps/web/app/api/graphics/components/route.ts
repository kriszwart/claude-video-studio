import { gt } from "drizzle-orm";
import { getDb, schema } from "@vs/db";
import { COMPONENTS } from "@vs/graphics/catalog";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Graphics components a scene can add, and whether a live worker can render each backend. */
export const GET = route(async () => {
  await requireSession();
  const rows = await getDb().query.workerCapabilities.findMany({ where: gt(schema.workerCapabilities.heartbeatAt, new Date(Date.now() - 120_000)) });
  const caps = rows.map((w) => (w.capabilities as { graphics?: { redraw?: boolean; skia?: boolean; three?: boolean; redrawReason?: string | null } }).graphics ?? {});
  const available = { skia: caps.some((c) => c.skia), redraw: caps.some((c) => c.redraw), three: caps.some((c) => c.three) };
  const redrawReason = available.redraw ? null : (caps.find((c) => c.redrawReason)?.redrawReason ?? "No worker with Redraw is running.");
  return json({ available, redrawReason, components: COMPONENTS.map(({ id, version, backend, name, description, params }) => ({ id, version, backend, name, description, params })) });
});
