import { z } from "zod";
import type { Estimate } from "@vs/domain";

/**
 * Owner-configured generation models. Endpoint ids, prices and limits come from the
 * provider's own pages at the time of setup; the studio never assumes them. A missing
 * price means every request needs explicit bounded authorisation (unknown price).
 */
export const GenerationModel = z.object({
  endpoint: z.string().regex(/^[a-z0-9-]+\/[a-z0-9._-]+(\/[a-z0-9._/-]+)?$/i, "Use the provider's endpoint id, e.g. owner/model"),
  priceMicros: z.number().int().min(0).max(100_000_000).nullable().default(null),
  priceCheckedAt: z.string().max(40).optional(),
  maxDurationSec: z.number().min(1).max(60).optional(),
  notes: z.string().max(300).default(""),
});
export const FalSettings = z.object({ image: GenerationModel.optional(), video: GenerationModel.optional() });
export type FalSettings = z.infer<typeof FalSettings>;

export function estimateFor(model: z.infer<typeof GenerationModel> | undefined): Estimate {
  if (!model) return { kind: "unknown", reason: "no model configured" };
  if (model.priceMicros === null) return { kind: "unknown", reason: `no price entered for ${model.endpoint}` };
  return { kind: "known", micros: model.priceMicros, priceTimestamp: model.priceCheckedAt ?? "owner-entered", basis: `owner-entered price for ${model.endpoint}` };
}

/**
 * ElevenLabs settings beyond the key. Music is billed from the owner's ElevenLabs plan; its price
 * is whatever the owner enters from their plan page. Without one, each request is an
 * unknown-price request that the project budget must explicitly authorise.
 */
export const ElevenLabsSettings = z.object({
  musicPriceMicrosPerMinute: z.number().int().min(0).max(100_000_000).nullable().default(null),
  priceCheckedAt: z.string().max(40).optional(),
  musicModel: z.string().max(60).regex(/^[a-z0-9._-]*$/i).optional(),
});
export type ElevenLabsSettings = z.infer<typeof ElevenLabsSettings>;

export function musicEstimate(settings: ElevenLabsSettings, lengthSec: number): Estimate {
  if (settings.musicPriceMicrosPerMinute === null) return { kind: "unknown", reason: "no ElevenLabs music price entered in Settings" };
  return { kind: "known", micros: Math.ceil((settings.musicPriceMicrosPerMinute * lengthSec) / 60), priceTimestamp: settings.priceCheckedAt ?? "owner-entered", basis: `owner-entered ElevenLabs music price per minute × ${Math.round(lengthSec)} s` };
}
