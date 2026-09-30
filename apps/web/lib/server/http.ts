import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError } from "@vs/db";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function errorResponse(e: unknown) {
  if (e instanceof AppError) return NextResponse.json(e.toJSON(), { status: e.status });
  if (e instanceof z.ZodError) {
    return NextResponse.json({ error: { code: "invalid_request", message: "The request was not valid.", details: e.issues.slice(0, 10) } }, { status: 400 });
  }
  console.error("[api] unexpected error", e instanceof Error ? e.stack : e);
  return NextResponse.json({ error: { code: "internal", message: "Something went wrong on the server." } }, { status: 500 });
}

type Ctx<P> = { params: Promise<P> };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cross-site request protection for every state-changing API call (PRD §28/A33). A browser
 * always sends Origin (and Sec-Fetch-Site) on cross-origin writes, so a page on another site
 * cannot submit prompts, edits or jobs to a studio running on this machine. Requests without
 * those headers come from non-browser clients (CLI, server webhooks) and are authorised by the
 * session/signature checks as usual.
 */
export function assertSameOrigin(req: Request) {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  const host = req.headers.get("host");
  const allowed = new Set<string>();
  if (host) allowed.add(host.toLowerCase());
  for (const u of [process.env.PUBLIC_BASE_URL, ...(process.env.STUDIO_ALLOWED_ORIGINS ?? "").split(",")]) {
    try {
      if (u?.trim()) allowed.add(new URL(u.trim()).host.toLowerCase());
    } catch {
      /* ignore malformed */
    }
  }
  if (origin && origin !== "null") {
    let h = "";
    try {
      h = new URL(origin).host.toLowerCase();
    } catch {
      /* invalid origin → rejected below */
    }
    if (allowed.has(h)) return;
  } else if (!origin && (!site || site === "same-origin" || site === "none")) {
    return;
  }
  throw new AppError(403, "cross_origin_request", "Requests from other websites are not accepted.", "Use the studio from its own address. If it is served behind another hostname, add that origin to STUDIO_ALLOWED_ORIGINS.");
}

/** Wrap a route handler with structured error responses. */
export function route<P = Record<string, string>>(fn: (req: Request, params: P) => Promise<Response>) {
  return async (req: Request, ctx: Ctx<P>) => {
    try {
      assertSameOrigin(req);
      return await fn(req, (await ctx?.params) ?? ({} as P));
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  const text = await req.text();
  if (text.length > 2_000_000) throw new AppError(413, "too_large", "Request body is too large.");
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new AppError(400, "invalid_json", "Request body must be JSON.");
  }
  return schema.parse(data);
}

/** Mutating job-creation requests carry an idempotency key (section 11). */
export function idempotencyKey(req: Request): string | null {
  const k = req.headers.get("idempotency-key");
  if (!k) return null;
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(k)) throw new AppError(400, "invalid_idempotency_key", "Idempotency-Key must be 8–128 URL-safe characters.");
  return k;
}
