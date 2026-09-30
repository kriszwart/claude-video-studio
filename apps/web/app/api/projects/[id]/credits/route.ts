import { getAssetsByIds, getDb, getProject } from "@vs/db";
import { referencedAssetIds } from "@vs/domain";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";

interface FootageProvenance {
  source?: string;
  footageSource?: string;
  title?: string;
  creator?: string | null;
  pageUrl?: string;
  license?: string;
  licenseStatus?: string;
  licenseUrl?: string | null;
  attributionRequired?: boolean;
  attribution?: string | null;
  licenseConfirmedByOwner?: boolean;
}

/**
 * Credits for footage used in the current revision: which clips need attribution (CC BY / BY-SA),
 * with ready-made credit lines, plus the licence of every other sourced clip for the record.
 */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const db = getDb();
  const { doc } = await getProject(db, id, s.workspaceId);
  const assets = await getAssetsByIds(db, referencedAssetIds(doc), s.workspaceId);
  const items = assets
    .filter((a) => (a.provenance as FootageProvenance).source === "footage")
    .map((a) => {
      const p = a.provenance as FootageProvenance;
      return { assetId: a.id, name: a.originalName, source: p.footageSource, title: p.title, creator: p.creator ?? null, pageUrl: p.pageUrl, license: p.license, licenseStatus: p.licenseStatus, licenseUrl: p.licenseUrl ?? null, attributionRequired: !!p.attributionRequired, attribution: p.attribution ?? null, licenseConfirmedByOwner: !!p.licenseConfirmedByOwner };
    });
  const required = items.filter((i) => i.attributionRequired || i.licenseStatus === "unknown");
  const text = required.map((i) => i.attribution ?? `“${i.title}” — ${i.license} — ${i.pageUrl}`).join("\n");
  return json({ items, attributionRequired: required.length > 0, creditsText: text });
});
