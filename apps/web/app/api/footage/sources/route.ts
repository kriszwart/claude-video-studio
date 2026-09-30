import { requireSession } from "@/lib/server/auth";
import { footageSources } from "@/lib/server/footage";
import { json, route } from "@/lib/server/http";

export const GET = route(async () => {
  const s = await requireSession();
  return json({ sources: await footageSources(s.workspaceId) });
});
