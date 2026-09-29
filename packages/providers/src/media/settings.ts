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
