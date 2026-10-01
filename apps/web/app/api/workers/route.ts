import { desc, gt } from "drizzle-orm";
import { getDb, schema } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Live render workers and what they can do (GPU, graphics runtimes), for Settings → Rendering. */
export const GET = route(async () => {
  await requireSession();
  const rows = await getDb().query.workerCapabilities.findMany({ where: gt(schema.workerCapabilities.heartbeatAt, new Date(Date.now() - 120_000)), orderBy: desc(schema.workerCapabilities.heartbeatAt) });
  const workers = rows.map((w) => {
    const c = w.capabilities as { gpu?: string; gpuMode?: string; graphics?: { redraw?: boolean; skia?: boolean } };
    return { id: w.workerId, heartbeatAt: w.heartbeatAt, gpu: c.gpu === "hardware" ? "hardware" : "software", gpuMode: c.gpuMode ?? "software", redraw: !!c.graphics?.redraw, skia: !!c.graphics?.skia };
  });
  return json({ workers });
});
