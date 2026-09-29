import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError, dataDir, getAsset, getDb, getStore } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const partPath = (id: string) => join(dataDir(), "uploads", `${id}.part`);
const received = async (id: string) => (await stat(partPath(id)).catch(() => null))?.size ?? 0;

/** Resumable upload status: how many bytes of the authorised size have arrived. */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const s = await requireSession();
  const a = await getAsset(getDb(), id, s.workspaceId);
  if (a.status !== "pending") return json({ received: Number(a.bytes), total: Number(a.bytes), complete: true });
  return json({ received: await received(id), total: Number(a.bytes), complete: false });
});

/**
 * Upload bytes. Without Content-Range the whole file is streamed in one request. With
 * "Content-Range: bytes start-end/total" chunks append to a staging file; a chunk must start
 * exactly where the previous one ended (409 + received offset otherwise), so an interrupted
 * upload resumes without re-sending completed chunks.
 */
export const PUT = route<{ id: string }>(async (req, { id }) => {
  const s = await requireSession();
  const a = await getAsset(getDb(), id, s.workspaceId);
  if (a.status !== "pending") throw new AppError(409, "already_uploaded", "This upload was already completed.");
  if (!req.body) throw new AppError(400, "empty_body", "No file data received.");
  const limit = Number(a.bytes);
  const range = req.headers.get("content-range");
  if (!range) {
    let seen = 0;
    const guard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length;
        if (seen > limit) cb(new AppError(413, "size_mismatch", "The upload is larger than authorised."));
        else cb(null, chunk);
      },
    });
    const r = await getStore().putStream(a.storageKey, Readable.fromWeb(req.body as never).pipe(guard), a.mime ?? undefined);
    if (r.bytes !== limit) {
      await getStore().delete(a.storageKey);
      throw new AppError(400, "size_mismatch", `Received ${r.bytes} bytes; expected ${limit}.`);
    }
    return json({ ok: true, bytes: r.bytes, complete: true });
  }
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
  if (!m) throw new AppError(400, "bad_range", "Content-Range must be 'bytes start-end/total'.");
  const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (total !== limit || end < start || end >= total) throw new AppError(400, "bad_range", "The range does not match the authorised size.");
  const have = await received(id);
  if (start !== have) return json({ error: { code: "range_mismatch", message: "Resume from the reported offset." }, received: have, total: limit }, 409);
  await mkdir(join(dataDir(), "uploads"), { recursive: true });
  let seen = 0;
  const expected = end - start + 1;
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > expected) cb(new AppError(413, "size_mismatch", "The chunk is larger than its range."));
      else cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(req.body as never), guard, createWriteStream(partPath(id), { flags: "a" }));
  const now = await received(id);
  if (now !== have + expected) {
    // A short chunk: keep what arrived; the client resumes from `received`.
    return json({ ok: false, received: now, total: limit }, 400);
  }
  if (now === limit) {
    await getStore().putStream(a.storageKey, createReadStream(partPath(id)), a.mime ?? undefined);
    await rm(partPath(id), { force: true });
    return json({ ok: true, received: now, total: limit, complete: true });
  }
  return json({ ok: true, received: now, total: limit, complete: false });
});
