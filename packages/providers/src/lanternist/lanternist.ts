import { z } from "zod";
import type { ProjectDocument } from "@vs/domain";
import { McpHttpClient } from "./mcp";

/**
 * Send a project's shot plan to Lanternist (a storyboard and review app) through its MCP server:
 * one shot per scene with what we see, the narration, an image prompt and the timing. Optional:
 * a public review link, and pictures drawn by Lanternist's own image generation (its credits).
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

export async function sendToLanternist(client: McpHttpClient, doc: ProjectDocument, opts: { reviewLink: boolean; pictures: boolean; onStage?: (s: string) => Promise<void> | void }): Promise<SendResult> {
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
  if (opts.pictures) {
    const film = await client.callTool<{ shots?: { id: string }[] }>("get_project", { project_id: projectId });
    for (const [i, shot] of (film?.shots ?? []).entries()) {
      await opts.onStage?.(`Lanternist is drawing shot ${i + 1} of ${film!.shots!.length}`);
      try {
        await client.callTool("make_picture", { scene_id: shot.id });
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
