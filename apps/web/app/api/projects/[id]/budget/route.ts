import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, getProject, schema } from "@vs/db";
import type { BudgetPolicy } from "@vs/domain";
import { requireOwner } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";

/** Owner-set spending limits (FR-12): per-project and per-operation ceilings, and a bounded number of unknown-price requests. */
export const PUT = route<{ id: string }>(async (req, { id }) => {
  const s = await requireOwner();
  const b = await body(req, z.object({ projectCeilingMicros: z.number().int().min(0).max(10_000_000_000), operationCeilingMicros: z.number().int().min(0).max(10_000_000_000), unknownPriceRequestsAuthorized: z.number().int().min(0).max(100) }));
  const { project } = await getProject(getDb(), id, s.workspaceId);
  const budget: BudgetPolicy = { currency: "USD", ...b };
  await getDb().update(schema.projects).set({ budget }).where(eq(schema.projects.id, project.id));
  return json({ budget });
});
