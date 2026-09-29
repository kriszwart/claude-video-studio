import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";
import { importServerFiles, listServerFiles } from "@/lib/server/collections";

export const dynamic = "force-dynamic";

/** Browse the operator's read-only import folder (owners only; never outside the root). */
export const GET = route<{ id: string }>(async (req) => {
  const s = await requireSession();
  return json(await listServerFiles(s, new URL(req.url).searchParams.get("path") ?? ""));
});

export const POST = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const b = await body(req, z.object({ paths: z.array(z.string().min(1).max(400)).min(1).max(500) }));
  return json({ results: await importServerFiles(s, id, b.paths) }, 202);
});
