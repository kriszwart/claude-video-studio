import { z } from "zod";
import { createCollection, DEFAULT_COLLECTION_LIMITS as d, getDb, listCollections } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";

export const GET = route(async () => {
  const s = await requireSession();
  return json({ collections: await listCollections(getDb(), s.workspaceId) });
});

/** Create an event collection (FR-16). Limits default from COLLECTION_MAX_* and can only be lowered here. */
export const POST = route(async (req) => {
  const s = await requireSession();
  const b = await body(req, z.object({ name: z.string().min(1).max(120), limits: z.object({ maxFiles: z.number().int().positive(), maxFileBytes: z.number().int().positive(), maxTotalBytes: z.number().int().positive() }).partial().default({}) }));
  const limits = { maxFiles: Math.min(d.maxFiles, b.limits.maxFiles ?? Infinity), maxFileBytes: Math.min(d.maxFileBytes, b.limits.maxFileBytes ?? Infinity), maxTotalBytes: Math.min(d.maxTotalBytes, b.limits.maxTotalBytes ?? Infinity) };
  const c = await createCollection(getDb(), s.workspaceId, b.name, limits);
  return json({ collection: c }, 201);
});
