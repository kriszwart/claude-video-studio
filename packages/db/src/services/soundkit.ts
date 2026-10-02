import { and, eq, sql } from "drizzle-orm";
import { SOUND_ROLES, type SoundRole } from "@vs/domain";
import type { DbOrTx } from "../client";
import { AppError } from "../errors";
import { assets } from "../schema";

/**
 * The workspace's sound kit: one real recording per role (whoosh, click, chime…). The role lives
 * on the audio asset (media.kitRole); its measured hit (media.sound) is written at ingest, or by
 * the placement job for sounds uploaded before measuring existed.
 */
export interface KitEntry {
  role: SoundRole;
  assetId: string;
  name: string;
  storageKey: string;
  durationSec: number;
  hitSec: number | null;
  peakSec: number | null;
}

/** Sound effects are short: anything longer is music or a recording. */
export const MAX_KIT_SOUND_SEC = 20;

export async function getSoundKit(db: DbOrTx, workspaceId: string): Promise<KitEntry[]> {
  const rows = await db.query.assets.findMany({ where: and(eq(assets.workspaceId, workspaceId), eq(assets.kind, "audio"), eq(assets.status, "ready"), sql`${assets.media}->>'kitRole' is not null`) });
  return rows
    .map((a) => {
      const m = a.media as { kitRole?: SoundRole; durationSec?: number; sound?: { hitSec: number; peakSec: number } };
      return { role: m.kitRole!, assetId: a.id, name: a.originalName, storageKey: a.storageKey, durationSec: Number(m.durationSec ?? 0), hitSec: m.sound?.hitSec ?? null, peakSec: m.sound?.peakSec ?? null };
    })
    .filter((e) => (SOUND_ROLES as readonly string[]).includes(e.role))
    .sort((a, b) => SOUND_ROLES.indexOf(a.role) - SOUND_ROLES.indexOf(b.role));
}

/** Put a sound in the kit for a role (replacing the previous one), or empty the role. */
export async function setKitSound(db: DbOrTx, workspaceId: string, role: SoundRole, assetId: string | null) {
  await db.update(assets).set({ media: sql`${assets.media} - 'kitRole'` }).where(and(eq(assets.workspaceId, workspaceId), sql`${assets.media}->>'kitRole' = ${role}`));
  if (!assetId) return;
  const a = await db.query.assets.findFirst({ where: and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)) });
  if (!a || a.kind !== "audio" || a.status !== "ready") throw new AppError(422, "invalid_input", "Choose an uploaded audio file.");
  const dur = Number((a.media as { durationSec?: number }).durationSec ?? 0);
  if (dur > MAX_KIT_SOUND_SEC) throw new AppError(422, "invalid_input", `Sound effects are at most ${MAX_KIT_SOUND_SEC} seconds; this file is ${Math.round(dur)} s.`);
  await db.update(assets).set({ media: sql`${assets.media} || ${JSON.stringify({ kitRole: role })}::jsonb` }).where(eq(assets.id, assetId));
}

export async function saveSoundHit(db: DbOrTx, assetId: string, sound: { hitSec: number; peakSec: number }) {
  await db.update(assets).set({ media: sql`${assets.media} || ${JSON.stringify({ sound })}::jsonb` }).where(eq(assets.id, assetId));
}
