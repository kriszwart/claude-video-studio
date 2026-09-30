import { attributionLine, classifyLicense, FootageError, getJson, type FootageAdapter, type FootageAdapterDeps, type FootageItem, type FootageKind, type FootageLicense } from "./types";

/**
 * Internet Archive (archive.org): advanced search + item metadata APIs, no key needed.
 * Many items carry a `licenseurl` (Public Domain Mark, CC0, CC licences); items without one
 * are reported as "unknown" rather than assumed free.
 */
const LABEL = "Internet Archive";
const MAX_BYTES = 190 * 1024 * 1024;

interface Doc { identifier: string; title?: string | string[]; creator?: string | string[]; licenseurl?: string; year?: string | number }
interface IaFile { name: string; format?: string; source?: string; size?: string; length?: string; width?: string; height?: string }
interface IaMetadata { metadata?: { identifier?: string; title?: string | string[]; creator?: string | string[]; licenseurl?: string; mediatype?: string }; files?: IaFile[]; is_dark?: boolean }

/** IA `length` is seconds ("123.4") or clock time ("01:02:03"). */
export function parseLength(v: string | undefined): number | null {
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const parts = v.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((a, n) => a * 60 + n, 0);
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

function license(id: string, title: string, creator: string | null, licenseurl: string | undefined): FootageLicense {
  const c = classifyLicense(licenseurl);
  const attributionRequired = c.status === "attribution";
  return { ...c, attributionRequired, attribution: attributionRequired || c.status === "unknown" ? attributionLine({ title, creator, licenseName: c.name, pageUrl: `https://archive.org/details/${id}`, sourceLabel: LABEL }) : null };
}

/** Pick an importable file: an MP4 derivative (smallest that is ≥ 480p when sizes are known) or the original image. */
export function pickIaFile(files: IaFile[], kind: FootageKind): IaFile | null {
  const size = (f: IaFile) => Number(f.size ?? 0);
  if (kind === "video") {
    const mp4 = files.filter((f) => /\.mp4$/i.test(f.name) && (!f.size || size(f) <= MAX_BYTES));
    if (!mp4.length) return null;
    const h = (f: IaFile) => Number(f.height ?? 0);
    const good = mp4.filter((f) => h(f) >= 480).sort((a, b) => h(a) - h(b) || size(a) - size(b));
    if (good.length) return good[0]!;
    return mp4.sort((a, b) => size(b) - size(a))[0]!;
  }
  const img = files.filter((f) => /\.(jpe?g|png)$/i.test(f.name) && f.source === "original" && (!f.size || size(f) <= 50 * 1024 * 1024));
  return img.sort((a, b) => size(b) - size(a))[0] ?? null;
}

export function internetArchive(deps: FootageAdapterDeps = {}): FootageAdapter {
  const f = deps.fetch ?? fetch;
  const base = (deps.baseUrl ?? "https://archive.org").replace(/\/$/, "");
  const toItem = (d: { identifier: string; title: string; creator: string | null; licenseurl?: string }, kind: FootageKind, extra: Partial<FootageItem> = {}): FootageItem => ({
    source: "internet_archive",
    id: d.identifier,
    kind,
    title: d.title,
    creator: d.creator,
    pageUrl: `https://archive.org/details/${d.identifier}`,
    thumbUrl: `${base}/services/img/${encodeURIComponent(d.identifier)}`,
    previewUrl: null,
    downloadUrl: null,
    license: license(d.identifier, d.title, d.creator, d.licenseurl),
    ...extra,
  });
  return {
    source: "internet_archive",
    label: LABEL,
    needsKey: false,
    kinds: ["video", "image"],
    async search(p) {
      const page = Math.max(1, p.page ?? 1);
      const rows = Math.min(50, p.perPage ?? 24);
      const terms = p.q.trim().replace(/[()":]/g, " ").trim();
      if (!terms) throw new FootageError("bad_request", "Enter something to search for.", 400);
      let q = `(${terms}) AND mediatype:(${p.kind === "video" ? "movies" : "image"})`;
      if (p.openOnly !== false) q += " AND licenseurl:(*publicdomain* OR *creativecommons.org/licenses/by/* OR *creativecommons.org/licenses/by-sa/*)";
      const u = new URL(`${base}/advancedsearch.php`);
      u.searchParams.set("q", q);
      for (const fl of ["identifier", "title", "creator", "licenseurl", "year"]) u.searchParams.append("fl[]", fl);
      u.searchParams.set("rows", String(rows));
      u.searchParams.set("page", String(page));
      u.searchParams.set("output", "json");
      const data = (await getJson(f, u.toString(), {}, deps.timeoutMs)) as { response?: { numFound?: number; docs?: Doc[] } };
      const docs = data.response?.docs ?? [];
      const total = data.response?.numFound ?? null;
      const items = docs.map((d) => toItem({ identifier: d.identifier, title: String(first(d.title) ?? d.identifier), creator: first(d.creator), licenseurl: d.licenseurl }, p.kind));
      return { items, total, page, nextPage: total !== null && page * rows < total ? page + 1 : null };
    },
    async resolve(id, kind) {
      if (!/^[A-Za-z0-9._-]{1,200}$/.test(id)) throw new FootageError("bad_request", "Invalid Internet Archive identifier.", 400);
      const m = (await getJson(f, `${base}/metadata/${encodeURIComponent(id)}`, {}, deps.timeoutMs)) as IaMetadata;
      if (!m.metadata || m.is_dark) throw new FootageError("not_found", "That Internet Archive item is not available.", 404);
      const file = pickIaFile(m.files ?? [], kind);
      if (!file) throw new FootageError("no_supported_file", kind === "video" ? "This item has no MP4 file small enough to import." : "This item has no original JPEG/PNG image.", 422);
      const title = String(first(m.metadata.title) ?? id);
      return toItem({ identifier: id, title, creator: first(m.metadata.creator), licenseurl: m.metadata.licenseurl }, kind, {
        downloadUrl: `${base}/download/${encodeURIComponent(id)}/${file.name.split("/").map(encodeURIComponent).join("/")}`,
        previewUrl: kind === "image" ? `${base}/download/${encodeURIComponent(id)}/${file.name.split("/").map(encodeURIComponent).join("/")}` : null,
        ...(file.width ? { width: Number(file.width) } : {}),
        ...(file.height ? { height: Number(file.height) } : {}),
        ...(parseLength(file.length) !== null ? { durationSec: parseLength(file.length)! } : {}),
      });
    },
  };
}
