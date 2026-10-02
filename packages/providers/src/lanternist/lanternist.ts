import { z } from "zod";
import type { ProjectDocument } from "@vs/domain";
import { McpHttpClient } from "./mcp";

/**
 * Send a project's shot plan to Lanternist (a storyboard and review app) through its MCP server:
 * one shot per scene with what we see, the narration, an image prompt and the timing. Optional:
 * a public review link, and pictures: drawn by Lanternist's own image generation (its credits), or
 * Fluxtify's own frames, attached by web address after the caller uploads them.
 */

export const LanternistSettings = z.object({
  /** Lanternist's MCP server address (from its "connect an assistant" settings). */
  mcpUrl: z.string().url().max(300).default("https://lanternist.app/mcp"),
});
export type LanternistSettings = z.infer<typeof LanternistSettings>;

export interface LanternistShot {
  description: string;
  narration?: string;
  image_prompt?: string;
  duration: number;
}

const ASPECTS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One Lanternist shot per scene (pure). */
export function lanternistShots(doc: ProjectDocument): LanternistShot[] {
  const fps = doc.format.fps;
  const brand = [doc.brand.name, doc.brand.colors.primary && `primary ${doc.brand.colors.primary}`, doc.brand.colors.accent && `accent ${doc.brand.colors.accent}`].filter(Boolean).join(", ");
  return doc.scenes.map((s, i) => {
    const words = s.layers.flatMap((l) => (l.kind === "text" && !l.hidden && l.text.trim() ? [l.text.trim()] : []));
    const media = s.layers.filter((l) => !l.hidden && (l.kind === "image" || l.kind === "video" || l.kind === "character")).map((l) => (l.kind === "character" ? "the mascot" : l.kind === "video" ? "footage" : "an image"));
    const how = [s.layout.replace(/-/g, " "), i > 0 && s.transitionIn.type !== "cut" ? `${s.transitionIn.type} in` : i > 0 ? "hard cut in" : ""].filter(Boolean).join(", ");
    const seen = [words.length ? `On screen: ${words.map((w) => `“${w}”`).join(", ")}.` : "", media.length ? `With ${[...new Set(media)].join(" and ")}.` : "", s.shot?.prompt ? `Shot: ${s.shot.prompt}` : ""].filter(Boolean).join(" ");
    const prompt = s.shot?.prompt || `${doc.format.aspect} frame for “${s.purpose}”: ${words.slice(0, 3).join(" / ") || s.purpose}, ${s.layout.replace(/-/g, " ")} layout${brand ? `, brand ${brand}` : ""}, clean motion-graphics style`;
    return {
      description: clip(`${s.purpose} (${how}). ${seen}`.trim(), 2000),
      ...(s.script.narration.trim() ? { narration: clip(s.script.narration.trim(), 2000) } : {}),
      image_prompt: clip(prompt, 2000),
      duration: Math.min(60, Math.max(1, Math.round((s.durationFrames / fps) * 10) / 10)),
    };
  });
}

export interface SendResult {
  projectId: string;
  editorUrl: string | null;
  reviewUrl: string | null;
  shots: number;
  pictures: { made: number; failed: number };
}

export type PictureSource = "none" | "lanternist" | "fluxtify";

export async function sendToLanternist(
  client: McpHttpClient,
  doc: ProjectDocument,
  opts: {
    reviewLink: boolean;
    pictures: PictureSource;
    /** For "fluxtify": a public https address of each scene's picture, by scene index (null: none). */
    pictureUrls?: (string | null)[];
    onStage?: (s: string) => Promise<void> | void;
  },
): Promise<SendResult> {
  await opts.onStage?.("creating the film in Lanternist");
  const created = await client.callTool<{ project_id?: string; editor_url?: string }>("create_project", {
    title: clip(`${doc.title} (from Fluxtify)`, 200),
    ...(ASPECTS.has(doc.format.aspect) ? { aspect_ratio: doc.format.aspect } : {}),
    style: clip([doc.brand.name && `${doc.brand.name} brand`, doc.brand.tone, "clean motion-graphics video"].filter(Boolean).join("; "), 500),
    shots: lanternistShots(doc),
  });
  const projectId = created?.project_id;
  if (!projectId) throw new Error("Lanternist didn't return a project id.");
  const pictures = { made: 0, failed: 0 };
  if (opts.pictures !== "none") {
    const film = await client.callTool<{ shots?: { id: string; scene_number?: number }[] }>("get_project", { project_id: projectId });
    // Shots come back in film order; scene_number (when given) is authoritative.
    const shots = [...(film?.shots ?? [])].sort((a, b) => (a.scene_number ?? 0) - (b.scene_number ?? 0));
    for (const [i, shot] of shots.entries()) {
      const url = opts.pictures === "fluxtify" ? opts.pictureUrls?.[i] : undefined;
      if (opts.pictures === "fluxtify" && !url) continue;
      await opts.onStage?.(opts.pictures === "lanternist" ? `Lanternist is drawing shot ${i + 1} of ${shots.length}` : `attaching picture ${i + 1} of ${shots.length}`);
      try {
        await client.callTool(opts.pictures === "lanternist" ? "make_picture" : "set_picture", opts.pictures === "lanternist" ? { scene_id: shot.id } : { scene_id: shot.id, image_url: url });
        pictures.made++;
      } catch {
        pictures.failed++;
      }
    }
  }
  let reviewUrl: string | null = null;
  if (opts.reviewLink) {
    await opts.onStage?.("creating the review link");
    reviewUrl = (await client.callTool<{ review_url?: string }>("create_review_link", { project_id: projectId, allow_comments: true }))?.review_url ?? null;
  }
  return { projectId, editorUrl: created.editor_url ?? null, reviewUrl, shots: doc.scenes.length, pictures };
}
