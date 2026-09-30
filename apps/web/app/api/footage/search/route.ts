import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { adapterFor, footageAppError } from "@/lib/server/footage";
import { json, route } from "@/lib/server/http";

const Q = z.object({
  source: z.enum(["internet_archive", "wikimedia", "pexels", "pixabay"]),
  q: z.string().trim().min(1).max(120),
  kind: z.enum(["video", "image"]).default("video"),
  page: z.coerce.number().int().min(1).max(50).default(1),
  openOnly: z.enum(["0", "1"]).default("1"),
});

/** Search one footage source. Results carry each item's licence as reported by the source. */
export const GET = route(async (req) => {
  const s = await requireSession();
  const p = Q.parse(Object.fromEntries(new URL(req.url).searchParams));
  try {
    const a = await adapterFor(s.workspaceId, p.source);
    return json(await a.search({ q: p.q, kind: p.kind, page: p.page, perPage: 24, openOnly: p.openOnly === "1" }));
  } catch (e) {
    throw footageAppError(e);
  }
});
