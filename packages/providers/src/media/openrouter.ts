import { z } from "zod";
import type { Estimate } from "@vs/domain";
import { MediaProviderError } from "./fal";

/**
 * OpenRouter images (Phase 4): one key for many image models (Gemini image, GPT image, …).
 * Uses the chat-completions image output documented by OpenRouter: `modalities: ["image","text"]`,
 * optional `image_config.aspect_ratio`, reference images as `image_url` content parts, and the
 * generated images in `choices[0].message.images[].image_url.url`. Claude is never routed here.
 * Model ids and prices are owner configuration; the request asks for usage accounting so the
 * ledger can settle at the cost OpenRouter reports when it does.
 */

export const OpenRouterSettings = z.object({
  image: z
    .object({
      model: z.string().regex(/^[a-z0-9-]+\/[a-z0-9._:-]+$/i, "Use the OpenRouter model id, e.g. provider/model"),
      priceMicros: z.number().int().min(0).max(100_000_000).nullable().default(null),
      priceCheckedAt: z.string().max(40).optional(),
    })
    .optional(),
  /** When both fal and OpenRouter have an image model, which one image shots use. */
  preferForImages: z.boolean().default(true),
});
export type OpenRouterSettings = z.infer<typeof OpenRouterSettings>;

export function openRouterEstimate(s: OpenRouterSettings): Estimate {
  if (!s.image) return { kind: "unknown", reason: "no OpenRouter image model configured" };
  if (s.image.priceMicros === null) return { kind: "unknown", reason: `no price entered for ${s.image.model}` };
  return { kind: "known", micros: s.image.priceMicros, priceTimestamp: s.image.priceCheckedAt ?? "owner-entered", basis: `owner-entered price for ${s.image.model}` };
}

export interface OpenRouterImageRequest {
  model: string;
  prompt: string;
  /** Reference images (product shots, character sheets), sent inline. */
  references: { mediaType: "image/jpeg" | "image/png"; data: string }[];
  aspectRatio?: string;
  signal?: AbortSignal;
}
export interface OpenRouterImageResult {
  /** data: URLs or https URLs, as returned. */
  images: string[];
  /** Cost in USD as reported by OpenRouter's usage accounting, when present. */
  costUsd: number | null;
  id: string | null;
  model: string | null;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class OpenRouterImages {
  readonly base: string;
  constructor(
    private key: string,
    private fetchImpl: Fetch = fetch,
    base?: string,
  ) {
    // Test seam: a local stand-in base URL outside production only.
    const override = process.env.NODE_ENV !== "production" ? process.env.OPENROUTER_BASE_URL : undefined;
    this.base = (base ?? override ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  }

  async generate(req: OpenRouterImageRequest): Promise<OpenRouterImageResult> {
    const content = [
      { type: "text", text: req.references.length ? `${req.prompt}\n\nUse the attached images as references: keep the product, characters and colours consistent with them.` : req.prompt },
      ...req.references.map((r) => ({ type: "image_url", image_url: { url: `data:${r.mediaType};base64,${r.data}` } })),
    ];
    const body = {
      model: req.model,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
      ...(req.aspectRatio ? { image_config: { aspect_ratio: req.aspectRatio } } : {}),
      usage: { include: true },
    };
    let r: Response;
    try {
      r = await this.fetchImpl(`${this.base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", "X-Title": "Fluxtify" },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      if (req.signal?.aborted) throw new MediaProviderError("network_uncertain", "Canceled while OpenRouter was generating; it may still bill the request.", false);
      // The request may have reached OpenRouter: never resend it automatically.
      throw new MediaProviderError("network_uncertain", `OpenRouter did not answer: ${(e as Error).message}`, false);
    }
    const text = await r.text();
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* non-JSON error pages are classified by status below */
    }
    const message = String((j.error as { message?: string } | undefined)?.message ?? text.slice(0, 200));
    if (r.status === 401 || r.status === 403) throw new MediaProviderError("credentials_invalid", "OpenRouter rejected the API key.", false, r.status);
    if (r.status === 402) throw new MediaProviderError("provider_failed", "Your OpenRouter account has insufficient credits.", false, r.status);
    if (r.status === 429) throw new MediaProviderError("rate_limited", "OpenRouter is rate limiting requests.", true, r.status);
    if (r.status === 400 || r.status === 404) throw new MediaProviderError("invalid_input", `OpenRouter refused the request: ${message}`, false, r.status);
    if (!r.ok) throw new MediaProviderError("provider_unavailable", `OpenRouter error ${r.status}: ${message}`, true, r.status);
    const choice = (j.choices as { message?: { images?: { image_url?: { url?: string } }[]; content?: unknown } }[] | undefined)?.[0];
    const images = (choice?.message?.images ?? []).map((i) => i.image_url?.url).filter((u): u is string => typeof u === "string" && (u.startsWith("data:image/") || u.startsWith("https://")));
    if (!images.length) throw new MediaProviderError("provider_failed", `${req.model} returned no image. Check that the model outputs images (its output modalities include "image").`, false);
    const cost = (j.usage as { cost?: unknown } | undefined)?.cost;
    return { images, costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null, id: typeof j.id === "string" ? j.id : null, model: typeof j.model === "string" ? j.model : null };
  }
}

/** Decode a data: URL image; null when it isn't one. */
export function decodeDataUrl(u: string): { mediaType: string; bytes: Buffer } | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(u);
  return m ? { mediaType: m[1]!.toLowerCase(), bytes: Buffer.from(m[2]!, "base64") } : null;
}
