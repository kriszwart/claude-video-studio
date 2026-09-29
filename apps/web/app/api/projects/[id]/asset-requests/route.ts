import { and, eq, inArray } from "drizzle-orm";
import { getDb, getProject, schema } from "@vs/db";
import { referencedAssetIds } from "@vs/domain";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Source = "upload" | "brand" | "url-import" | "screenshot" | "generated" | "supplied-footage" | "sample" | "render" | "missing";

/**
 * Asset request list (FR-15): every media slot per scene with where its asset came from and
 * the provenance kept for it (source URL, retrieval date, licence note, generation record).
 */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const db = getDb();
  const { doc } = await getProject(db, id, s.workspaceId);
  const ids = referencedAssetIds(doc);
  const rows = ids.length ? await db.query.assets.findMany({ where: and(inArray(schema.assets.id, ids), eq(schema.assets.workspaceId, s.workspaceId)) }) : [];
  const byId = new Map(rows.map((a) => [a.id, a]));
  const classify = (assetId: string | null | undefined, supplied: boolean): { source: Source; asset?: Record<string, unknown> } => {
    if (!assetId) return { source: "missing" };
    const a = byId.get(assetId);
    if (!a) return { source: "missing" };
    const p = a.provenance as Record<string, unknown>;
    const source: Source = a.isSample ? "sample" : a.generated ? "generated" : p.source === "screenshot" ? "screenshot" : p.source === "url" || p.source === "url-import" || typeof p.url === "string" ? "url-import" : doc.brand.logoAssetId === a.id ? "brand" : supplied ? "supplied-footage" : "upload";
    return { source, asset: { id: a.id, name: a.originalName, kind: a.kind, url: p.url ?? p.sourceUrl ?? null, retrievedAt: p.retrievedAt ?? p.importedAt ?? p.uploadedAt ?? p.generatedAt ?? null, license: p.license ?? null, rightsAcknowledged: a.rightsAcknowledged, provider: p.provider ?? null, prompt: p.prompt ?? null } };
  };
  const requests = doc.scenes.flatMap((sc, i) =>
    sc.layers
      .filter((l) => l.kind === "image" || l.kind === "video" || (l.kind === "graphics" && Object.values(l.params).some((v) => typeof v === "string" && v.startsWith("ast_"))))
      .map((l) => {
        const assetId = l.kind === "graphics" ? (Object.values(l.params).find((v) => typeof v === "string" && v.startsWith("ast_")) as string) : l.kind === "image" || l.kind === "video" ? l.assetId : null;
        return { scene: i + 1, sceneId: sc.id, purpose: sc.purpose, layerId: l.id, slot: l.slot, kind: l.kind, shot: sc.shot ? { status: sc.shot.status, source: sc.shot.source } : null, ...classify(assetId, sc.shot?.source === "supplied") };
      }),
  );
  return json({ policy: doc.acquisitionPolicy, requests, facts: doc.brief.approvedFacts });
});
