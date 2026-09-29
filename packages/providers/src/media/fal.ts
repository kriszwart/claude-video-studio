/**
 * fal queue adapter (image/video generation). The HTTP contract follows the official
 * @fal-ai/client 1.10.1 queue implementation:
 *   submit  POST {queue}/{endpoint}[?fal_webhook=URL]        Authorization: Key <FAL_KEY>
 *           → { request_id, status_url, response_url, cancel_url, status: "IN_QUEUE" }
 *   status  GET  {queue}/{owner}/{alias}/requests/{id}/status → { status: IN_QUEUE|IN_PROGRESS|COMPLETED, error? }
 *   result  GET  {queue}/{owner}/{alias}/requests/{id}
 *   cancel  PUT  {queue}/{owner}/{alias}/requests/{id}/cancel
 *   webhook POST body { status: "OK"|"ERROR", request_id, payload, error? }
 * Webhook signatures are checked with fal's published Ed25519 JWKS scheme (see
 * verifyFalWebhook). STATUS: implemented and exercised against a local fake queue in tests;
 * NOT verified against live fal (no key; fal.run is unreachable from this environment).
 * Model endpoints, prices and duration limits are owner configuration, never assumed.
 */
import { createHash, createPublicKey, verify } from "node:crypto";

export class MediaProviderError extends Error {
  constructor(
    public code: "credentials_invalid" | "invalid_input" | "rate_limited" | "provider_unavailable" | "provider_failed" | "network_uncertain" | "not_found",
    message: string,
    public retryable: boolean,
    public status?: number,
  ) {
    super(message);
  }
}

export type QueueState = "queued" | "running" | "completed" | "failed";
export interface MediaFile {
  url: string;
  contentType?: string;
  width?: number;
  height?: number;
}

function endpointBase(endpoint: string): string {
  // "owner/alias/sub/path" → status/result live under "owner/alias".
  const parts = endpoint.replace(/^\/+/, "").split("/");
  return parts.slice(0, 2).join("/");
}

export class FalQueue {
  readonly id = "fal";
  constructor(
    private apiKey: string,
    private base = process.env.FAL_QUEUE_BASE_URL ?? "https://queue.fal.run",
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(method: string, url: string, body?: unknown, signal?: AbortSignal) {
    let r: Response;
    try {
      r = await this.fetchImpl(url, { method, headers: { Authorization: `Key ${this.apiKey}`, "Content-Type": "application/json", Accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch (e) {
      // The request may or may not have reached the provider.
      throw new MediaProviderError("network_uncertain", `fal did not answer (${(e as Error).message}).`, false);
    }
    const text = await r.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (r.status === 401 || r.status === 403) throw new MediaProviderError("credentials_invalid", "fal rejected the API key.", false, r.status);
    if (r.status === 404) throw new MediaProviderError("not_found", "fal does not know this endpoint or request.", false, r.status);
    if (r.status === 400 || r.status === 422) throw new MediaProviderError("invalid_input", `fal rejected the input: ${text.slice(0, 300)}`, false, r.status);
    if (r.status === 429) throw new MediaProviderError("rate_limited", "fal is rate limiting requests.", true, r.status);
    if (r.status >= 500) throw new MediaProviderError("provider_unavailable", `fal returned ${r.status}.`, true, r.status);
    if (!r.ok) throw new MediaProviderError("provider_failed", `fal returned ${r.status}: ${text.slice(0, 200)}`, false, r.status);
    return json as Record<string, unknown>;
  }

  async submit(endpoint: string, input: Record<string, unknown>, opts: { webhookUrl?: string; signal?: AbortSignal } = {}): Promise<{ requestId: string }> {
    const q = opts.webhookUrl ? `?fal_webhook=${encodeURIComponent(opts.webhookUrl)}` : "";
    const j = await this.call("POST", `${this.base}/${endpoint.replace(/^\/+/, "")}${q}`, input, opts.signal);
    const requestId = String(j.request_id ?? "");
    if (!requestId) throw new MediaProviderError("network_uncertain", "fal accepted the request but returned no request id.", false);
    return { requestId };
  }

  async status(endpoint: string, requestId: string, signal?: AbortSignal): Promise<{ state: QueueState; raw: Record<string, unknown> }> {
    const j = await this.call("GET", `${this.base}/${endpointBase(endpoint)}/requests/${encodeURIComponent(requestId)}/status`, undefined, signal);
    const s = String(j.status ?? "");
    const state: QueueState = s === "COMPLETED" ? (j.error ? "failed" : "completed") : s === "IN_PROGRESS" ? "running" : s === "IN_QUEUE" ? "queued" : "failed";
    return { state, raw: j };
  }

  async result(endpoint: string, requestId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.call("GET", `${this.base}/${endpointBase(endpoint)}/requests/${encodeURIComponent(requestId)}`, undefined, signal);
  }

  async cancel(endpoint: string, requestId: string): Promise<void> {
    await this.call("PUT", `${this.base}/${endpointBase(endpoint)}/requests/${encodeURIComponent(requestId)}/cancel`);
  }
}

/** Media files in a fal result payload: {images:[{url}]}, {image:{url}}, {video:{url}}, {videos:[…]}. */
export function falOutputFiles(payload: unknown): MediaFile[] {
  const out: MediaFile[] = [];
  const take = (v: unknown) => {
    if (v && typeof v === "object" && typeof (v as { url?: unknown }).url === "string") {
      const o = v as { url: string; content_type?: string; width?: number; height?: number };
      out.push({ url: o.url, contentType: o.content_type, width: o.width, height: o.height });
    }
  };
  const p = (payload ?? {}) as Record<string, unknown>;
  for (const key of ["images", "videos"]) if (Array.isArray(p[key])) (p[key] as unknown[]).forEach(take);
  for (const key of ["image", "video"]) take(p[key]);
  return out;
}

export interface Jwk {
  kty: string;
  crv?: string;
  x?: string;
  kid?: string;
}

/**
 * fal webhook authenticity (Ed25519). Signed message:
 *   request_id \n user_id \n timestamp \n sha256_hex(raw body)
 * with headers x-fal-webhook-request-id / -user-id / -timestamp / -signature (hex), and a
 * ±5 minute timestamp window. Any JWKS key may verify.
 */
export function verifyFalWebhook(headers: Record<string, string | undefined>, rawBody: Buffer, jwks: Jwk[], nowSec = Math.floor(Date.now() / 1000)): { ok: true } | { ok: false; reason: string } {
  const rid = headers["x-fal-webhook-request-id"];
  const uid = headers["x-fal-webhook-user-id"];
  const ts = headers["x-fal-webhook-timestamp"];
  const sig = headers["x-fal-webhook-signature"];
  if (!rid || !uid || !ts || !sig) return { ok: false, reason: "missing signature headers" };
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > 300) return { ok: false, reason: "timestamp outside the allowed window" };
  const msg = Buffer.from([rid, uid, ts, createHash("sha256").update(rawBody).digest("hex")].join("\n"));
  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(sig, "hex");
  } catch {
    return { ok: false, reason: "malformed signature" };
  }
  for (const k of jwks) {
    if (k.kty !== "OKP" || k.crv !== "Ed25519" || !k.x) continue;
    try {
      if (verify(null, msg, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" }), sigBuf)) return { ok: true };
    } catch {
      /* try the next key */
    }
  }
  return { ok: false, reason: "signature does not verify" };
}
