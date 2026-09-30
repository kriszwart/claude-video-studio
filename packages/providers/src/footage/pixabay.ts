import { FootageError, getJson, type FootageAdapter, type FootageAdapterDeps, type FootageItem, type FootageLicense } from "./types";

/**
 * Pixabay API (free key: https://pixabay.com/api/docs/). Content is under the Pixabay Content
 * License; the API terms ask apps to show that results come from Pixabay, and to download
 * files rather than hotlink them — the studio imports a copy.
 */
const LABEL = "Pixabay";
const LICENSE: FootageLicense = { status: "platform", name: "Pixabay Content License", url: "https://pixabay.com/service/license-summary/", attributionRequired: false, attribution: null };

interface Rendition { url: string; width: number; height: number; size?: number; thumbnail?: string }
interface PixabayVideo { id: number; pageURL: string; tags?: string; duration?: number; user?: string; videos: { large?: Rendition; medium?: Rendition; small?: Rendition; tiny?: Rendition } }
interface PixabayImage { id: number; pageURL: string; tags?: string; user?: string; previewURL?: string; webformatURL?: string; largeImageURL?: string; imageWidth?: number; imageHeight?: number }

const titleOf = (tags: string | undefined, fallback: string) => (tags?.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 4).join(", ") || fallback).replace(/^./, (c) => c.toUpperCase());
const credit = (title: string, creator: string | null, pageUrl: string) => ({ ...LICENSE, attribution: [`“${title}”`, creator ? `by ${creator}` : null, "Pixabay", pageUrl].filter(Boolean).join(" — ") });

export function pixabayVideoItem(v: PixabayVideo): FootageItem {
  const best = [v.videos.large, v.videos.medium, v.videos.small, v.videos.tiny].find((r) => r?.url && r.width <= 1920 && r.width > 0) ?? v.videos.medium ?? v.videos.small;
  const preview = v.videos.tiny?.url || v.videos.small?.url || null;
  const title = titleOf(v.tags, `Pixabay video ${v.id}`);
  const creator = v.user ?? null;
  return { source: "pixabay", id: String(v.id), kind: "video", title, creator, pageUrl: v.pageURL, thumbUrl: v.videos.tiny?.thumbnail || v.videos.small?.thumbnail || null, previewUrl: preview, downloadUrl: best?.url || null, ...(best ? { width: best.width, height: best.height } : {}), ...(v.duration ? { durationSec: v.duration } : {}), license: credit(title, creator, v.pageURL) };
}
export function pixabayImageItem(i: PixabayImage): FootageItem {
  const title = titleOf(i.tags, `Pixabay image ${i.id}`);
  const creator = i.user ?? null;
  return { source: "pixabay", id: String(i.id), kind: "image", title, creator, pageUrl: i.pageURL, thumbUrl: i.previewURL ?? i.webformatURL ?? null, previewUrl: i.webformatURL ?? null, downloadUrl: i.largeImageURL ?? i.webformatURL ?? null, ...(i.imageWidth ? { width: i.imageWidth, height: i.imageHeight } : {}), license: credit(title, creator, i.pageURL) };
}

export function pixabay(deps: FootageAdapterDeps = {}): FootageAdapter {
  const f = deps.fetch ?? fetch;
  const base = (deps.baseUrl ?? "https://pixabay.com").replace(/\/$/, "");
  const get = (path: string, params: Record<string, string>) => {
    if (!deps.apiKey) throw new FootageError("not_configured", "Add a Pixabay API key in Settings to search Pixabay.", 412);
    const u = new URL(`${base}${path}`);
    u.searchParams.set("key", deps.apiKey);
    u.searchParams.set("safesearch", "true");
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return getJson(f, u.toString(), {}, deps.timeoutMs);
  };
  return {
    source: "pixabay",
    label: LABEL,
    needsKey: true,
    kinds: ["video", "image"],
    async search(p) {
      const page = Math.max(1, p.page ?? 1);
      const per = Math.max(3, Math.min(200, p.perPage ?? 24));
      const q = p.q.trim().slice(0, 100);
      if (!q) throw new FootageError("bad_request", "Enter something to search for.", 400);
      const d = (await get(p.kind === "video" ? "/api/videos/" : "/api/", { q, page: String(page), per_page: String(per), ...(p.kind === "image" ? { image_type: "photo" } : {}) })) as { totalHits?: number; hits?: (PixabayVideo & PixabayImage)[] };
      const items = (d.hits ?? []).map((h) => (p.kind === "video" ? pixabayVideoItem(h) : pixabayImageItem(h)));
      const total = d.totalHits ?? null;
      return { items, total, page, nextPage: total !== null && page * per < total ? page + 1 : null };
    },
    async resolve(id, kind) {
      if (!/^\d{1,15}$/.test(id)) throw new FootageError("bad_request", "Invalid Pixabay id.", 400);
      const d = (await get(kind === "video" ? "/api/videos/" : "/api/", { id })) as { hits?: (PixabayVideo & PixabayImage)[] };
      const h = d.hits?.[0];
      if (!h) throw new FootageError("not_found", "That Pixabay item no longer exists.", 404);
      const item = kind === "video" ? pixabayVideoItem(h) : pixabayImageItem(h);
      if (!item.downloadUrl) throw new FootageError("no_supported_file", "This Pixabay item has no downloadable file.", 422);
      return item;
    },
  };
}
