import "server-only";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "public", "template-posters");
const EXT = ["png", "jpg", "jpeg", "webp"];

/**
 * A template's thumbnail: its own illustration (public/template-posters/<template-id>.png|jpg|webp)
 * if one was added, else a real frame rendered by its family, else none (the card shows a
 * gradient). Resolved on the server so the browser never requests a missing file.
 */
export function templatePoster(templateId: string, family: string): { url: string; kind: "own" | "family" } | null {
  for (const ext of EXT) if (existsSync(join(DIR, `${templateId}.${ext}`))) return { url: `/template-posters/${templateId}.${ext}`, kind: "own" };
  if (templateId !== family) for (const ext of EXT) if (existsSync(join(DIR, `${family}.${ext}`))) return { url: `/template-posters/${family}.${ext}`, kind: "family" };
  return null;
}
