import { FootageError, getJson, type FootageAdapter, type FootageAdapterDeps, type FootageItem, type FootageLicense } from "./types";

/**
 * Pexels API (free key: https://www.pexels.com/api/). Everything is under the Pexels License:
 * free to use, attribution not required (the studio still records the photographer/videographer).
 */
const LABEL = "Pexels";
const LICENSE: FootageLicense = { status: "platform", name: "Pexels License", url: "https://www.pexels.com/license/", attributionRequired: false, attribution: null };

interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  duration: number;
  url: string;
  image: string;
  user?: { name?: string; url?: string };
  video_files: { id: number; quality?: string | null; file_type: string; width: number | null; height: number | null; link: string }[];
}
interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  alt?: string;
  photographer?: string;
  src: { original: string; large2x?: string; large?: string; medium?: string; small?: string; tiny?: string };
}

const credit = (title: string, creator: string | null, pageUrl: string) => ({ ...LICENSE, attribution: [`“${title}”`, creator ? `by ${creator}` : null, "Pexels", pageUrl].filter(Boolean).join(" — ") });
const titleFromUrl = (url: string, fallback: string) => {
  const slug = /\/(?:video|photo)\/([a-z0-9-]+?)-\d+\/?$/.exec(url)?.[1];
  return slug ? slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()) : fallback;
};

/** The largest MP4 no wider than 1920 px (the studio exports ≤1080p). */
export function pickPexelsFile(files: PexelsVideo["video_files"]) {
  const mp4 = files.filter((f) => f.file_type === "video/mp4" && f.width);
  const fit = mp4.filter((f) => (f.width ?? 0) <= 1920).sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return fit[0] ?? mp4.sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0] ?? null;
}
const smallest = (files: PexelsVideo["video_files"]) => files.filter((f) => f.file_type === "video/mp4" && f.width).sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0] ?? null;

export function pexelsVideoItem(v: PexelsVideo): FootageItem {
  const title = titleFromUrl(v.url, `Pexels video ${v.id}`);
  const creator = v.user?.name ?? null;
  return { source: "pexels", id: String(v.id), kind: "video", title, creator, pageUrl: v.url, thumbUrl: v.image, previewUrl: smallest(v.video_files)?.link ?? null, downloadUrl: pickPexelsFile(v.video_files)?.link ?? null, width: v.width, height: v.height, durationSec: v.duration, license: credit(title, creator, v.url) };
}
export function pexelsPhotoItem(p: PexelsPhoto): FootageItem {
  const title = p.alt?.trim() || titleFromUrl(p.url, `Pexels photo ${p.id}`);
  const creator = p.photographer ?? null;
  return { source: "pexels", id: String(p.id), kind: "image", title, creator, pageUrl: p.url, thumbUrl: p.src.medium ?? p.src.small ?? null, previewUrl: p.src.large ?? p.src.medium ?? null, downloadUrl: p.src.large2x ?? p.src.original, width: p.width, height: p.height, license: credit(title, creator, p.url) };
}

export function pexels(deps: FootageAdapterDeps = {}): FootageAdapter {
  const f = deps.fetch ?? fetch;
  const base = (deps.baseUrl ?? "https://api.pexels.com").replace(/\/$/, "");
  const get = (path: string) => {
    if (!deps.apiKey) throw new FootageError("not_configured", "Add a Pexels API key in Settings to search Pexels.", 412);
    return getJson(f, `${base}${path}`, { headers: { Authorization: deps.apiKey } }, deps.timeoutMs);
  };
  return {
    source: "pexels",
    label: LABEL,
    needsKey: true,
    kinds: ["video", "image"],
    async search(p) {
      const page = Math.max(1, p.page ?? 1);
      const per = Math.min(80, p.perPage ?? 24);
      const q = encodeURIComponent(p.q.trim());
      if (!q) throw new FootageError("bad_request", "Enter something to search for.", 400);
      if (p.kind === "video") {
        const d = (await get(`/videos/search?query=${q}&per_page=${per}&page=${page}`)) as { total_results?: number; next_page?: string; videos?: PexelsVideo[] };
        return { items: (d.videos ?? []).map(pexelsVideoItem), total: d.total_results ?? null, page, nextPage: d.next_page ? page + 1 : null };
      }
      const d = (await get(`/v1/search?query=${q}&per_page=${per}&page=${page}`)) as { total_results?: number; next_page?: string; photos?: PexelsPhoto[] };
      return { items: (d.photos ?? []).map(pexelsPhotoItem), total: d.total_results ?? null, page, nextPage: d.next_page ? page + 1 : null };
    },
    async resolve(id, kind) {
      if (!/^\d{1,15}$/.test(id)) throw new FootageError("bad_request", "Invalid Pexels id.", 400);
      const item = kind === "video" ? pexelsVideoItem((await get(`/videos/videos/${id}`)) as PexelsVideo) : pexelsPhotoItem((await get(`/v1/photos/${id}`)) as PexelsPhoto);
      if (!item.downloadUrl) throw new FootageError("no_supported_file", "This Pexels video has no MP4 file.", 422);
      return item;
    },
  };
}
