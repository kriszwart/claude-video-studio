import { Readable } from "node:stream";
import { AppError, getAsset, getDb, getStore, verifyAssetSignature } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Signed, short-lived artifact download. Requires both an authenticated session in the
 * owning workspace and a valid signature; supports HTTP Range for video seeking.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const s = await requireSession();
    const u = new URL(req.url);
    const exp = Number(u.searchParams.get("exp"));
    const d = u.searchParams.get("d") ?? "inline";
    const v = u.searchParams.get("v") ?? "original";
    if (!verifyAssetSignature(id, s.workspaceId, exp, d, v, u.searchParams.get("sig") ?? "")) throw new AppError(403, "bad_signature", "This link has expired or is invalid.");
    const a = await getAsset(getDb(), id, s.workspaceId);
    const derived = a.derived as { thumbKey?: string; proxyKey?: string; rasterKey?: string };
    const key = v === "thumb" ? derived.thumbKey : v === "proxy" ? derived.proxyKey : v === "raster" ? derived.rasterKey : a.storageKey;
    if (!key) throw new AppError(404, "not_found", "This variant does not exist.");
    const mime = v === "thumb" ? "image/jpeg" : v === "proxy" ? "video/mp4" : v === "raster" ? "image/png" : (a.mime ?? "application/octet-stream");
    const store = getStore();
    const size = await store.size(key);
    const headers: Record<string, string> = {
      "Content-Type": mime === "image/svg+xml" ? "application/octet-stream" : mime,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=300",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `${d === "attachment" || mime === "image/svg+xml" ? "attachment" : "inline"}; filename="${a.originalName.replace(/"/g, "")}"`,
    };
    const range = req.headers.get("range");
    const m = range?.match(/bytes=(\d*)-(\d*)/);
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      const stream = await store.openRead(key, { start, end });
      return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
    }
    const stream = await store.openRead(key);
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
  } catch (e) {
    return errorResponse(e);
  }
}
