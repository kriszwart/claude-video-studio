import { attributionLine, classifyLicense, FootageError, getJson, stripHtml, type FootageAdapter, type FootageAdapterDeps, type FootageItem, type FootageKind } from "./types";

/**
 * Wikimedia Commons: MediaWiki API (search in the File namespace + imageinfo with extmetadata),
 * no key needed. Every file carries its own licence and attribution terms.
 */
const LABEL = "Wikimedia Commons";
/** Formats the studio can ingest. Commons video is mostly WebM/Ogg; Ogg Theora is not supported. */
const MIME: Record<FootageKind, RegExp> = { video: /^video\/webm$/, image: /^image\/(jpeg|png|webp)$/ };

interface ExtMeta { value?: string }
interface ImageInfo {
  url: string;
  thumburl?: string;
  descriptionurl?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  extmetadata?: Record<string, ExtMeta | undefined>;
}
interface Page { pageid: number; title: string; imageinfo?: ImageInfo[] }

export function wikimediaItem(page: Page, kind: FootageKind): FootageItem | null {
  const ii = page.imageinfo?.[0];
  if (!ii || !ii.mime || !MIME[kind].test(ii.mime)) return null;
  const em = ii.extmetadata ?? {};
  const title = stripHtml(em.ObjectName?.value) || page.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "");
  const creator = stripHtml(em.Artist?.value) || stripHtml(em.Credit?.value) || null;
  const c = classifyLicense(em.LicenseShortName?.value || em.License?.value || em.UsageTerms?.value || null);
  const url = em.LicenseUrl?.value ?? c.url;
  const pageUrl = ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`;
  const attributionRequired = em.AttributionRequired?.value === "true" || c.status === "attribution";
  return {
    source: "wikimedia",
    id: String(page.pageid),
    kind,
    title,
    creator,
    pageUrl,
    thumbUrl: ii.thumburl ?? null,
    previewUrl: kind === "video" ? ii.url : (ii.thumburl ?? ii.url),
    downloadUrl: ii.url,
    ...(ii.width ? { width: ii.width } : {}),
    ...(ii.height ? { height: ii.height } : {}),
    ...(ii.duration ? { durationSec: ii.duration } : {}),
    license: { ...c, url: url ?? null, attributionRequired, attribution: attributionRequired || c.status === "unknown" ? attributionLine({ title, creator, licenseName: c.name, pageUrl, sourceLabel: LABEL }) : null },
  };
}

export function wikimedia(deps: FootageAdapterDeps = {}): FootageAdapter {
  const f = deps.fetch ?? fetch;
  const api = `${(deps.baseUrl ?? "https://commons.wikimedia.org").replace(/\/$/, "")}/w/api.php`;
  const common = (u: URL) => {
    u.searchParams.set("action", "query");
    u.searchParams.set("format", "json");
    u.searchParams.set("formatversion", "1");
    u.searchParams.set("prop", "imageinfo");
    u.searchParams.set("iiprop", "url|size|mime|extmetadata|mediatype");
    u.searchParams.set("iiurlwidth", "480");
    u.searchParams.set("origin", "*");
  };
  return {
    source: "wikimedia",
    label: LABEL,
    needsKey: false,
    kinds: ["video", "image"],
    async search(p) {
      const page = Math.max(1, p.page ?? 1);
      const limit = Math.min(50, p.perPage ?? 24);
      const terms = p.q.trim();
      if (!terms) throw new FootageError("bad_request", "Enter something to search for.", 400);
      const u = new URL(api);
      common(u);
      u.searchParams.set("generator", "search");
      u.searchParams.set("gsrnamespace", "6");
      u.searchParams.set("gsrsearch", `${terms} filetype:${p.kind === "video" ? "video" : "bitmap"}`);
      u.searchParams.set("gsrlimit", String(limit));
      u.searchParams.set("gsroffset", String((page - 1) * limit));
      const data = (await getJson(f, u.toString(), {}, deps.timeoutMs)) as { query?: { pages?: Record<string, Page & { index?: number }> }; continue?: { gsroffset?: number } };
      const pages = Object.values(data.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      let items = pages.map((pg) => wikimediaItem(pg, p.kind)).filter((x): x is FootageItem => !!x);
      if (p.openOnly !== false) items = items.filter((i) => ["public_domain", "cc0", "attribution"].includes(i.license.status));
      return { items, total: null, page, nextPage: data.continue?.gsroffset !== undefined ? page + 1 : null };
    },
    async resolve(id, kind) {
      if (!/^\d{1,12}$/.test(id)) throw new FootageError("bad_request", "Invalid Wikimedia Commons page id.", 400);
      const u = new URL(api);
      common(u);
      u.searchParams.set("pageids", id);
      const data = (await getJson(f, u.toString(), {}, deps.timeoutMs)) as { query?: { pages?: Record<string, Page & { missing?: string }> } };
      const pg = data.query?.pages?.[id];
      if (!pg || "missing" in pg) throw new FootageError("not_found", "That Wikimedia Commons file no longer exists.", 404);
      const item = wikimediaItem(pg, kind);
      if (!item) throw new FootageError("no_supported_file", kind === "video" ? "Only WebM video from Wikimedia Commons can be imported (not Ogg Theora)." : "Only JPEG, PNG or WebP images can be imported.", 422);
      return item;
    },
  };
}
