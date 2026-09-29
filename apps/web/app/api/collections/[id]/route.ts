import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";
import { collectionView } from "@/lib/server/collections";

export const dynamic = "force-dynamic";

/** Collection with items, bytes, source duration, indexing status, failures and limits. */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  return json(await collectionView(id, s.workspaceId));
});
