/** Minimal helpers for writing structured-output JSON Schemas by hand (all fields required, no extras). */
export type JsonSchema = Record<string, unknown>;

export const str = (description?: string): JsonSchema => ({ type: "string", ...(description ? { description } : {}) });
export const num = (description?: string): JsonSchema => ({ type: "number", ...(description ? { description } : {}) });
export const int = (description?: string): JsonSchema => ({ type: "integer", ...(description ? { description } : {}) });
export const bool = (description?: string): JsonSchema => ({ type: "boolean", ...(description ? { description } : {}) });
export const nullable = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: "null" }] });
export const enm = (values: readonly string[], description?: string): JsonSchema => ({ type: "string", enum: [...values], ...(description ? { description } : {}) });
export const arr = (items: JsonSchema, description?: string): JsonSchema => ({ type: "array", items, ...(description ? { description } : {}) });
export const obj = (properties: Record<string, JsonSchema>, description?: string): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
  ...(description ? { description } : {}),
});
export const constant = (v: string): JsonSchema => ({ type: "string", const: v });
