import { z } from "zod";
import { AppError, enqueueJob, getDb } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { adapterFor, footageAppError } from "@/lib/server/footage";
import { body, idempotencyKey, json, route } from "@/lib/server/http";
import { serializeJob } from "@/lib/server/serialize";

const Req = z.object({
  source: z.enum(["internet_archive", "wikimedia", "pexels", "pixabay"]),
  id: z.string().min(1).max(200),
  kind: z.enum(["video", "image"]),
  rightsAcknowledged: z.literal(true),
  /** Required when the source states no licence: the owner confirms they checked the item page. */
  confirmUnknownLicense: z.boolean().optional(),
});

/**
 * Import one footage item. The item is re-fetched from the source by id (the browser never
 * supplies the download URL), its licence is checked, and the file is imported through the
 * usual SSRF-guarded, content-validated path with the licence recorded as provenance.
 */
export const POST = route(async (req) => {
  const s = await requireSession();
  const b = await body(req, Req);
  let item;
  try {
    item = await (await adapterFor(s.workspaceId, b.source)).resolve(b.id, b.kind);
  } catch (e) {
    throw footageAppError(e);
  }
  if (item.license.status === "restricted") {
    throw new AppError(422, "license_restricted", `“${item.title}” is licensed ${item.license.name}, which doesn't allow the commercial or modified use a video edit needs.`, "Pick a public-domain, CC0, CC BY or CC BY-SA item.");
  }
  if (item.license.status === "unknown" && !b.confirmUnknownLicense) {
    throw new AppError(409, "license_unconfirmed", `${item.license.name === "No licence stated" ? "The source states no licence" : `The licence (“${item.license.name}”) isn't one the studio recognises`} for “${item.title}”.`, `Check the item page (${item.pageUrl}) and confirm you may use it before importing.`);
  }
  const idem = idempotencyKey(req);
  const { job } = await getDb().transaction((tx) =>
    enqueueJob(tx, {
      workspaceId: s.workspaceId,
      projectId: null,
      revisionId: null,
      type: "import_url",
      input: {
        url: item.downloadUrl,
        rightsAcknowledged: true,
        footage: { source: item.source, id: item.id, kind: item.kind, title: item.title, creator: item.creator, pageUrl: item.pageUrl, license: item.license, ...(item.license.status === "unknown" ? { confirmedUnknownLicense: true } : {}) },
      },
      idempotencyKey: idem ? `footage:${idem}` : null,
    }),
  );
  return json({ job: serializeJob(job), item }, 202);
});
