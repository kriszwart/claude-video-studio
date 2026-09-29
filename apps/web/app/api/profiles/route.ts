import { z } from "zod";
import { createProfile, getDb, listProfiles } from "@vs/db";
import { profileFromTraits } from "@vs/domain";
import { PROFILE_PRESETS } from "@vs/templates";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";

export const GET = route(async () => {
  const s = await requireSession();
  return json({ profiles: await listProfiles(getDb(), s.workspaceId), presets: PROFILE_PRESETS });
});

const Trait = z.object({ field: z.string().max(40), value: z.unknown(), basis: z.enum(["measured", "interpretation", "not measured"]), detail: z.string().max(600), evidence: z.array(z.object({ timeSec: z.number().optional(), assetId: z.string().max(64).optional(), metric: z.string().max(60).optional() })).max(40) });

/** Save a profile (explicit user action): from selected reference traits, a preset, or data. */
export const POST = route(async (req) => {
  const s = await requireSession();
  const b = await body(req, z.object({ name: z.string().min(1).max(80), preset: z.string().max(40).optional(), data: z.record(z.string(), z.unknown()).optional(), traits: z.array(Trait).max(20).optional(), sourceAssetId: z.string().max(64).optional() }));
  const base = b.preset ? PROFILE_PRESETS[b.preset] : undefined;
  const data = b.traits ? profileFromTraits(b.name, b.traits as never, { ...base, ...b.data }) : { ...base, ...b.data, name: b.name };
  const r = await createProfile(getDb(), s.workspaceId, { name: b.name, data, evidence: b.traits as never, sourceAssetId: b.sourceAssetId });
  return json(r, 201);
});
