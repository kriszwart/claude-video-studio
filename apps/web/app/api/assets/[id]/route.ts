import { assetUsage, getAsset, getDb } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";
import { serializeAsset } from "@/lib/server/serialize";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const a = await getAsset(getDb(), id, s.workspaceId);
  return json({ asset: serializeAsset(a), usage: await assetUsage(getDb(), s.workspaceId, id) });
});
