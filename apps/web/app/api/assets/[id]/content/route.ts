import { Readable, Transform } from "node:stream";
import { AppError, getAsset, getDb, getStore } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Stream upload bytes into storage, enforcing the authorised size. */
export const PUT = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const a = await getAsset(getDb(), id, s.workspaceId);
  if (a.status !== "pending") throw new AppError(409, "already_uploaded", "This upload was already completed.");
  if (!req.body) throw new AppError(400, "empty_body", "No file data received.");
  const limit = Number(a.bytes);
  let seen = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > limit) cb(new AppError(413, "size_mismatch", "The upload is larger than authorised."));
      else cb(null, chunk);
    },
  });
  const src = Readable.fromWeb(req.body as never).pipe(guard);
  const r = await getStore().putStream(a.storageKey, src, a.mime ?? undefined);
  if (r.bytes !== limit) {
    await getStore().delete(a.storageKey);
    throw new AppError(400, "size_mismatch", `Received ${r.bytes} bytes; expected ${limit}.`);
  }
  return json({ ok: true, bytes: r.bytes });
});
