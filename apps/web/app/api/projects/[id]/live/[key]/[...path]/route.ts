import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { dataDir, getDb, getProject, getRevision, notFound } from "@vs/db";
import { requireSession } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

/** Which project a live bundle belongs to (from its live.json), cached in-process. */
const owners = new Map<string, { projectId: string; revisionId: string }>();

/**
 * Serve a live-preview bundle (the editor player's iframe). The bundle key is content-derived
 * and immutable; access requires a session in the workspace that owns the bundle's project.
 * Media supports byte ranges so the player can seek.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; key: string; path: string[] }> }) {
  try {
    const { id, key, path } = await ctx.params;
    const s = await requireSession();
    if (!/^[0-9a-f]{24}$/.test(key)) throw notFound("Preview");
    const root = join(dataDir(), "live", key);
    let owner = owners.get(key);
    if (!owner) {
      const meta = JSON.parse(await readFile(join(root, "live.json"), "utf8").catch(() => "null")) as { revisionId?: string } | null;
      if (!meta?.revisionId) throw notFound("Preview");
      owner = { projectId: id, revisionId: meta.revisionId };
    }
    // The bundle's revision must belong to this project, in the caller's workspace.
    if (owner.projectId !== id) throw notFound("Preview");
    await getProject(getDb(), id, s.workspaceId, { includeDeleted: false });
    await getRevision(getDb(), id, owner.revisionId);
    owners.set(key, owner);

    const rel = normalize(path.join("/"));
    if (rel.startsWith("..") || rel.includes(`${sep}..`) || rel.startsWith(sep)) throw notFound("File");
    const file = join(root, "bundle", rel);
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) throw notFound("File");
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string> = {
      "Content-Type": type,
      "Cache-Control": "private, max-age=31536000, immutable",
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
    };
    if (type.startsWith("text/html")) {
      // Only the studio may frame it; scripts are the composition's own and the vendored runtimes.
      headers["Content-Security-Policy"] = "frame-ancestors 'self'; default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' blob: data:; worker-src 'self' blob:";
    }
    const range = req.headers.get("range");
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
      let end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
      if (start >= st.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${st.size}` } });
      end = Math.min(end, st.size - 1);
      start = Math.max(0, start);
      const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
      return new Response(body, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": String(end - start + 1) } });
    }
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { status: 200, headers: { ...headers, "Content-Length": String(st.size) } });
  } catch (e) {
    return errorResponse(e);
  }
}
