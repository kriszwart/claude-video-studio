import { and, asc, desc, eq } from "drizzle-orm";
import { CreativeProfileSnapshot, diffProfiles, type ProfileChange, type ProfileData, type ProposedTrait } from "@vs/domain";
import type { DbOrTx } from "../client";
import { AppError, notFound } from "../errors";
import { newId } from "../ids";
import { creativeProfiles, creativeProfileVersions } from "../schema";

/**
 * Creative profiles (FR-17): versioned, workspace-owned editing taste. Every save is an
 * explicit user action that creates a new immutable version with its diff; projects pin a
 * version and are never updated implicitly.
 */
function clean(data: unknown): ProfileData {
  const { profileId: _p, version: _v, ...rest } = CreativeProfileSnapshot.parse(data);
  return rest;
}

export async function createProfile(db: DbOrTx, workspaceId: string, input: { name: string; data: unknown; evidence?: ProposedTrait[]; sourceAssetId?: string }) {
  const data = clean({ ...(input.data as object), name: input.name });
  const id = newId("cpr");
  const [profile] = await db.insert(creativeProfiles).values({ id, workspaceId, name: data.name, latestVersion: 1 }).returning();
  const [version] = await db
    .insert(creativeProfileVersions)
    .values({ id: newId("cpv"), profileId: id, version: 1, data, evidence: { traits: input.evidence ?? [], sourceAssetId: input.sourceAssetId ?? null }, changeSummary: [] })
    .returning();
  return { profile: profile!, version: version! };
}

export async function listProfiles(db: DbOrTx, workspaceId: string) {
  return db.query.creativeProfiles.findMany({ where: eq(creativeProfiles.workspaceId, workspaceId), orderBy: [desc(creativeProfiles.createdAt)] });
}

export async function getProfile(db: DbOrTx, id: string, workspaceId: string) {
  const profile = await db.query.creativeProfiles.findFirst({ where: and(eq(creativeProfiles.id, id), eq(creativeProfiles.workspaceId, workspaceId)) });
  if (!profile) throw notFound("Creative profile");
  const versions = await db.query.creativeProfileVersions.findMany({ where: eq(creativeProfileVersions.profileId, id), orderBy: [asc(creativeProfileVersions.version)] });
  return { profile, versions: versions.map((v) => ({ ...v, data: clean(v.data), changeSummary: v.changeSummary as ProfileChange[] })) };
}

/**
 * Save a new version. `baseVersion` must be the latest (no silent overwrite of a concurrent
 * save); the stored change summary is the real diff, annotated with the feedback reasons.
 */
export async function saveProfileVersion(db: DbOrTx, id: string, workspaceId: string, input: { baseVersion: number; data: unknown; reasons?: ProfileChange[] }) {
  const rows = await db.select().from(creativeProfiles).where(and(eq(creativeProfiles.id, id), eq(creativeProfiles.workspaceId, workspaceId))).for("update");
  const profile = rows[0];
  if (!profile) throw notFound("Creative profile");
  if (profile.latestVersion !== input.baseVersion) throw new AppError(409, "stale_version", `This profile is now at v${profile.latestVersion}. Review the latest version first.`);
  const prev = await db.query.creativeProfileVersions.findFirst({ where: and(eq(creativeProfileVersions.profileId, id), eq(creativeProfileVersions.version, input.baseVersion)) });
  const before = clean(prev!.data);
  const data = clean(input.data);
  const changes = diffProfiles(before, data).map((c) => ({ ...c, because: input.reasons?.find((r) => r.field === c.field)?.because }));
  if (!changes.length) throw new AppError(422, "no_changes", "Nothing changed, so no new version was created.");
  const version = input.baseVersion + 1;
  const [row] = await db.insert(creativeProfileVersions).values({ id: newId("cpv"), profileId: id, version, data, evidence: prev!.evidence, changeSummary: changes }).returning();
  await db.update(creativeProfiles).set({ latestVersion: version, name: data.name }).where(eq(creativeProfiles.id, id));
  return { version: { ...row!, data, changeSummary: changes } };
}

/** The snapshot a project pins when a version is applied. */
export async function profileSnapshot(db: DbOrTx, id: string, workspaceId: string, version: number) {
  const { versions } = await getProfile(db, id, workspaceId);
  const v = versions.find((x) => x.version === version);
  if (!v) throw notFound("Profile version");
  return CreativeProfileSnapshot.parse({ ...v.data, profileId: id, version });
}
