import "server-only";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "public", "template-posters");
/** Real frames rendered by each template family (kept apart from owner-supplied art). */
const FRAMES = join(DIR, "frames");
const EXT = ["png", "jpg", "jpeg", "webp"];

/**
 * A template's thumbnail: its own image (public/template-posters/<template-id>.png|jpg|webp) if
 * one was added, else a real frame rendered by its family (public/template-posters/frames/),
 * else none (the card shows a gradient). A preset never borrows another template's own image.
 * Resolved on the server so the browser never requests a missing file.
 */
export function templatePoster(templateId: string, family: string): { url: string; kind: "own" | "family" | "frame" } | null {
  for (const ext of EXT) if (existsSync(join(DIR, `${templateId}.${ext}`))) return { url: `/template-posters/${templateId}.${ext}`, kind: "own" };
  for (const ext of EXT) if (existsSync(join(FRAMES, `${family}.${ext}`))) return { url: `/template-posters/frames/${family}.${ext}`, kind: templateId === family ? "frame" : "family" };
  return null;
}
