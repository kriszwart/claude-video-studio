/**
 * SSRF-safe HTTP(S) fetch for URL import and reference fetching (FR-03, §13).
 *  - only http/https on ports 80/443;
 *  - every hostname is resolved and ALL addresses must be public unicast (no loopback,
 *    private, link-local incl. 169.254.169.254 metadata, CGNAT, multicast, reserved,
 *    IPv4-mapped IPv6 of those, unique-local IPv6 …);
 *  - the connection is pinned to the validated address (no second DNS lookup → no rebinding);
 *  - redirects are followed manually (max 3) and each hop is re-validated;
 *  - response size, content type and total time are bounded.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export class UnsafeUrlError extends Error {
  constructor(public code: "invalid_url" | "blocked_address" | "blocked_port" | "too_many_redirects" | "too_large" | "bad_type" | "http_error" | "timeout", message: string) {
    super(message);
  }
}

function v4ToInt(ip: string) {
  return ip.split(".").reduce((a, p) => (a << 8) + Number(p), 0) >>> 0;
}
function inV4(ip: string, cidr: string) {
  const [base, bits] = cidr.split("/");
  const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base!) & mask);
}
const BLOCKED_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32"];

/** True when the address is a public unicast address. */
export function isPublicAddress(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return !BLOCKED_V4.some((c) => inV4(ip, c));
  if (fam !== 6) return false;
  const a = ip.toLowerCase();
  // IPv4-mapped / -compatible / NAT64 forms: judge the embedded IPv4.
  const m = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (m) return isPublicAddress(m[1]!);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hexMapped) {
    const n = (parseInt(hexMapped[1]!, 16) << 16) | parseInt(hexMapped[2]!, 16);
    return isPublicAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  if (a === "::" || a === "::1") return false;
  const first = parseInt(a.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (a.startsWith("2001:db8") || a.startsWith("2001:0db8")) return false; // documentation
  return true;
}

export interface SafeFetchOptions {
  maxBytes: number;
  allowedTypes: RegExp;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  /** Test seam: resolve a hostname (defaults to the system resolver, all addresses). */
  resolve?: (host: string) => Promise<string[]>;
  /** Test seam: treat these exact addresses as public (e.g. a local fixture server). */
  trustAddresses?: string[];
  /** Test seam: extra ports allowed (only together with trusted addresses). */
  allowPorts?: number[];
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
  address: string;
  redirects: string[];
}

async function validate(raw: string, o: SafeFetchOptions): Promise<{ url: URL; address: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("invalid_url", "That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("invalid_url", "Only http and https links can be imported.");
  if (url.username || url.password) throw new UnsafeUrlError("invalid_url", "Links with embedded credentials are not accepted.");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (port !== 80 && port !== 443 && !(o.allowPorts ?? []).includes(port)) throw new UnsafeUrlError("blocked_port", "Only standard web ports (80/443) are allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // WHATWG URL parsing already normalises decimal/hex/octal IPv4 forms (e.g. 2130706433).
  const addrs = net.isIP(host) ? [host] : await (o.resolve ?? (async (h: string) => (await dnsLookup(h, { all: true, verbatim: true })).map((x) => x.address)))(host).catch(() => []);
  if (!addrs.length) throw new UnsafeUrlError("invalid_url", `The host ${host} could not be resolved.`);
  const trusted = new Set(o.trustAddresses ?? []);
  const bad = addrs.find((a) => !trusted.has(a) && !isPublicAddress(a));
  if (bad) throw new UnsafeUrlError("blocked_address", "This link points to a private or internal network address and can't be fetched.");
  return { url, address: addrs[0]! };
}

function once(url: URL, address: string, o: SafeFetchOptions): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        headers: { "user-agent": "VideoStudio-Import/1", accept: "*/*" },
        // Pin the connection to the address we validated (defeats DNS rebinding).
        lookup: ((_h: string, lo: { all?: boolean }, cb: (e: Error | null, a: string | { address: string; family: number }[], f?: number) => void) =>
          lo?.all ? cb(null, [{ address, family: net.isIP(address) }]) : cb(null, address, net.isIP(address))) as never,
        servername: net.isIP(url.hostname) ? undefined : url.hostname,
        agent: false,
        signal: o.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > o.maxBytes) {
          res.destroy();
          return reject(new UnsafeUrlError("too_large", "The linked file is larger than the import limit."));
        }
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > o.maxBytes) {
            res.destroy();
            reject(new UnsafeUrlError("too_large", "The linked file is larger than the import limit."));
          } else chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.setTimeout(o.timeoutMs ?? 20_000, () => req.destroy(new UnsafeUrlError("timeout", "The link took too long to respond.")));
    req.on("error", reject);
    req.end();
  });
}

export async function safeFetch(raw: string, o: SafeFetchOptions): Promise<SafeFetchResult> {
  const redirects: string[] = [];
  let current = raw;
  for (let hop = 0; hop <= (o.maxRedirects ?? 3); hop++) {
    const { url, address } = await validate(current, o);
    const r = await once(url, address, o);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      redirects.push(current);
      current = new URL(String(r.headers.location), url).toString();
      continue;
    }
    if (r.status < 200 || r.status >= 300) throw new UnsafeUrlError("http_error", `The link returned HTTP ${r.status}.`);
    const contentType = String(r.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!o.allowedTypes.test(contentType)) throw new UnsafeUrlError("bad_type", `Links to ${contentType || "unknown content"} can't be imported.`);
    return { finalUrl: url.toString(), status: r.status, contentType, body: r.body, address, redirects };
  }
  throw new UnsafeUrlError("too_many_redirects", "The link redirected too many times.");
}
