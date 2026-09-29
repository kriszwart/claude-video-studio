/** Client-generated ids for new scenes/layers (validated server-side like any other id). */
export function newClientId(prefix: string): string {
  const a = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${Array.from(a, (b) => "0123456789abcdefghjkmnpqrstvwxyz"[b & 31]).join("")}`;
}
