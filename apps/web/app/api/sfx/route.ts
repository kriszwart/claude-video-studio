import { z } from "zod";
import { getDb, getSoundKit, setKitSound } from "@vs/db";
import { SOUND_ROLES } from "@vs/domain";
import { requireOwner, requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";

/** The workspace's sound kit: one short, real recording per role. */
export const GET = route(async () => {
  const s = await requireSession();
  const kit = await getSoundKit(getDb(), s.workspaceId);
  return json({ kit: kit.map(({ storageKey: _k, ...e }) => e) });
});

/** Put a sound in the kit for a role, or clear the role (assetId null). */
export const PUT = route(async (req) => {
  const s = await requireOwner();
  const b = await body(req, z.object({ role: z.enum(SOUND_ROLES), assetId: z.string().max(64).nullable() }));
  await setKitSound(getDb(), s.workspaceId, b.role, b.assetId);
  const kit = await getSoundKit(getDb(), s.workspaceId);
  return json({ kit: kit.map(({ storageKey: _k, ...e }) => e) });
});
