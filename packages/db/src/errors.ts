/** Structured, user-facing errors with recovery guidance (section 11). */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public recovery?: string,
    public details?: unknown,
  ) {
    super(message);
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, recovery: this.recovery, details: this.details } };
  }
}

export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} was not found.`);
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, "stale_revision", message, "Reload the latest revision; your unsaved edits are kept locally for reconciliation.", details);
export const badRequest = (message: string, details?: unknown) => new AppError(400, "invalid_request", message, undefined, details);
