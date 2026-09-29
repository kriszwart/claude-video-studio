import { getDb, listAssets, type AssetKind } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";
import { serializeAsset } from "@/lib/server/serialize";

export const GET = route(async (req) => {
  const s = await requireSession();
  const u = new URL(req.url);
  const kind = (u.searchParams.get("kind") ?? undefined) as AssetKind | undefined;
  const rows = await listAssets(getDb(), s.workspaceId, { kind, q: u.searchParams.get("q") ?? undefined });
  return json({ assets: rows.map(serializeAsset) });
});
