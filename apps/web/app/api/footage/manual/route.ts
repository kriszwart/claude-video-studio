import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { AppError, enqueueJob, getAsset, getDb, schema } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { serializeJob } from "@/lib/server/serialize";

/**
 * Assisted sources without an API (Moving Image Archive): the owner finds and downloads a shot
 * on the site themselves; the studio never makes automated requests to it. This records the
 * shot's page, title and the public-domain status the owner confirmed on that page — either on
 * a file they uploaded (assetId) or by importing a direct file link they pasted (fileUrl).
 */
const MIA = /^https:\/\/(www\.)?movingimagearchive\.com\/\S+$/i;
const LABEL = "Moving Image Archive";

const Req = z
  .object({
    source: z.literal("moving_image_archive"),
    pageUrl: z.string().max(500).regex(MIA, "Paste the shot's page address from movingimagearchive.com."),
    title: z.string().trim().min(1).max(160),
    assetId: z.string().max(64).optional(),
    fileUrl: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), "Only http and https links can be imported.").optional(),
    confirmPublicDomain: z.literal(true, { message: "Confirm that the shot's page marks it as public domain." }),
    rightsAcknowledged: z.literal(true),
  })
  .refine((b) => !!b.assetId !== !!b.fileUrl, { message: "Provide either an uploaded file or a direct file link." });

function miaRecord(b: { pageUrl: string; title: string }) {
  return {
    source: "footage",
    footageSource: "moving_image_archive",
    footageId: b.pageUrl,
    title: b.title,
    creator: null,
    pageUrl: b.pageUrl,
    license: "Public domain (as marked on Moving Image Archive)",
    licenseStatus: "public_domain",
    licenseUrl: null,
    attributionRequired: false,
    attribution: `“${b.title}” — public domain — via ${LABEL} — ${b.pageUrl}`,
    licenseConfirmedByOwner: true,
    recordedAt: new Date().toISOString(),
  };
}

export const POST = route(async (req) => {
  const s = await requireSession();
  const b = await body(req, Req);
  const db = getDb();
  if (b.assetId) {
    const a = await getAsset(db, b.assetId, s.workspaceId);
    if (a.kind !== "video" && a.kind !== "image" && a.status === "ready") throw new AppError(422, "invalid_asset", "Only a video or image can be recorded as footage.");
    const prev = a.provenance as Record<string, unknown>;
    const record = miaRecord(b);
    // An identical file already sourced elsewhere keeps its licence as primary; this source is
    // added alongside (same rule as deduplicated footage imports). Otherwise the upload record
    // (upload time, original name) is kept and the shot record added.
    await db
      .update(schema.assets)
      .set({
        provenance:
          prev.source === "footage" && prev.footageId !== record.footageId
            ? sql`jsonb_set(${schema.assets.provenance}, '{alsoFrom}', coalesce(${schema.assets.provenance}->'alsoFrom', '[]'::jsonb) || ${JSON.stringify([record])}::jsonb)`
            : sql`${schema.assets.provenance} || ${JSON.stringify({ ...record, uploadedVia: prev.source === "footage" ? prev.uploadedVia ?? "upload" : prev.source ?? "upload" })}::jsonb`,
      })
      .where(eq(schema.assets.id, a.id));
    return json({ assetId: a.id });
  }
  const idem = idempotencyKey(req);
  const { job } = await db.transaction((tx) =>
    enqueueJob(tx, {
      workspaceId: s.workspaceId,
      projectId: null,
      revisionId: null,
      type: "import_url",
      input: {
        url: b.fileUrl,
        rightsAcknowledged: true,
        footage: { source: "moving_image_archive", id: b.pageUrl, kind: "video", title: b.title, creator: null, pageUrl: b.pageUrl, license: { status: "public_domain", name: "Public domain (as marked on Moving Image Archive)", url: null, attributionRequired: false, attribution: miaRecord(b).attribution }, confirmedUnknownLicense: true },
      },
      idempotencyKey: idem ? `footage-manual:${idem}` : null,
    }),
  );
  return json({ job: serializeJob(job) }, 202);
});
