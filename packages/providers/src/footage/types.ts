/**
 * Stock / archival footage search (B-roll). Each source adapter talks to that service's
 * official API and reports the licence of every item it returns; the studio records it as
 * the asset's provenance. A licence is never inferred from "it's on the internet".
 */
export type FootageSource = "internet_archive" | "wikimedia" | "pexels" | "pixabay";
export type FootageKind = "video" | "image";

export type LicenseStatus =
  /** No known copyright (Public Domain Mark, PD-US, …). */
  | "public_domain"
  /** CC0 dedication. */
  | "cc0"
  /** CC BY / CC BY-SA: usable with attribution (and share-alike for BY-SA). */
  | "attribution"
  /** A platform's own free licence (Pexels License, Pixabay Content License). */
  | "platform"
  /** Non-commercial / no-derivatives / all rights reserved: not importable here. */
  | "restricted"
  /** The source gives no licence: import only after the owner has checked it. */
  | "unknown";

export interface FootageLicense {
  status: LicenseStatus;
  /** Human-readable name, e.g. "CC BY-SA 4.0", "Public Domain Mark 1.0", "Pexels License". */
  name: string;
  url: string | null;
  attributionRequired: boolean;
  /** Ready-to-use credit line (title — creator — licence — source), when attribution applies. */
  attribution: string | null;
}

export interface FootageItem {
  source: FootageSource;
  /** Source-specific id; the server re-resolves items by id, never by a client-supplied URL. */
  id: string;
  kind: FootageKind;
  title: string;
  creator: string | null;
  pageUrl: string;
  thumbUrl: string | null;
  /** Small playable preview (video) or display-size image. */
  previewUrl: string | null;
  /** The file that would be imported (null until resolved when the search API doesn't list files). */
  downloadUrl: string | null;
  width?: number;
  height?: number;
  durationSec?: number;
  license: FootageLicense;
}

export interface FootageSearchParams {
  q: string;
  kind: FootageKind;
  page?: number;
  perPage?: number;
  /** Only items with a public-domain / CC0 / CC BY(-SA) licence (sources that mix licences). */
  openOnly?: boolean;
}

export interface FootageSearchResult {
  items: FootageItem[];
  total: number | null;
  page: number;
  nextPage: number | null;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface FootageAdapterDeps {
  fetch?: Fetch;
  apiKey?: string;
  /** API base URL override (tests). */
  baseUrl?: string;
  timeoutMs?: number;
}

export interface FootageAdapter {
  source: FootageSource;
  label: string;
  needsKey: boolean;
  kinds: FootageKind[];
  search(p: FootageSearchParams): Promise<FootageSearchResult>;
  /** Fetch one item fresh from the source, with its download URL resolved. */
  resolve(id: string, kind: FootageKind): Promise<FootageItem>;
}

export class FootageError extends Error {
  constructor(
    public code: "not_configured" | "not_found" | "provider_error" | "rate_limited" | "no_supported_file" | "bad_request",
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

/** Classify a licence URL / short name into a status. */
export function classifyLicense(urlOrName: string | null | undefined): { status: LicenseStatus; name: string; url: string | null } {
  const raw = (urlOrName ?? "").trim();
  if (!raw) return { status: "unknown", name: "No licence stated", url: null };
  const s = raw.toLowerCase();
  const url = /^https?:\/\//.test(raw) ? raw : null;
  const ver = /(\d\.\d)/.exec(s)?.[1];
  if (/publicdomain\/zero|\bcc0\b|cc-zero/.test(s)) return { status: "cc0", name: "CC0", url };
  if (/publicdomain\/mark|public domain mark|^pd\b|pd-|public[ _-]?domain|no known copyright/.test(s)) return { status: "public_domain", name: `Public domain${/mark/.test(s) ? ` (Mark${ver ? ` ${ver}` : ""})` : ""}`, url };
  if (/-nc|\bnc\b|noncommercial|by-nc|-nd|\bnd\b|noderiv|all rights reserved|©|copyrighted/.test(s)) return { status: "restricted", name: url ? ccName(s) ?? raw : raw, url };
  if (/licenses\/by-sa|cc[ -]by-sa|\bby-sa\b/.test(s)) return { status: "attribution", name: `CC BY-SA${ver ? ` ${ver}` : ""}`, url };
  if (/licenses\/by\/|cc[ -]by\b|^by\b/.test(s)) return { status: "attribution", name: `CC BY${ver ? ` ${ver}` : ""}`, url };
  return { status: "unknown", name: raw.slice(0, 80), url };
}

function ccName(s: string): string | null {
  const m = /licenses\/([a-z-]+)\/(\d\.\d)/.exec(s);
  return m ? `CC ${m[1]!.toUpperCase()} ${m[2]}` : null;
}

export function attributionLine(i: { title: string; creator: string | null; licenseName: string; pageUrl: string; sourceLabel: string }): string {
  return [`“${i.title}”`, i.creator ? `by ${i.creator}` : null, i.licenseName, `via ${i.sourceLabel}`, i.pageUrl].filter(Boolean).join(" — ");
}

/** Licences that may be imported (unknown only with the owner's explicit confirmation). */
export const IMPORTABLE: LicenseStatus[] = ["public_domain", "cc0", "attribution", "platform", "unknown"];

export async function getJson(f: Fetch, url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<unknown> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let r: Response;
  try {
    r = await f(url, { ...init, signal: ac.signal, headers: { Accept: "application/json", "User-Agent": "claude-video-studio (footage search)", ...(init.headers ?? {}) } });
  } catch {
    throw new FootageError("provider_error", "The footage service could not be reached.");
  } finally {
    clearTimeout(t);
  }
  if (r.status === 429) throw new FootageError("rate_limited", "The footage service is rate-limiting requests. Try again in a minute.", 429);
  if (r.status === 404) throw new FootageError("not_found", "That item no longer exists at the source.", 404);
  if (r.status === 401 || r.status === 403) throw new FootageError("not_configured", "The footage service rejected the API key.", 412);
  if (!r.ok) throw new FootageError("provider_error", `The footage service returned ${r.status}.`);
  try {
    return await r.json();
  } catch {
    throw new FootageError("provider_error", "The footage service returned an unreadable response.");
  }
}

export const stripHtml = (s: string | null | undefined) => (s ?? "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
