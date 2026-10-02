import { getDb, getProject, getProviderSecret, getProviderSettings, JobError } from "@vs/db";
import { LanternistSettings, McpError, McpHttpClient, sendToLanternist } from "@vs/providers";
import type { Handler } from "../context";

/**
 * Send to Lanternist: the project's shot plan becomes a Lanternist film (one shot per scene,
 * with timing, narration and an image prompt), optionally with a public review link and pictures
 * drawn by Lanternist's own image generation. Nothing in the Fluxtify project changes.
 */
export const sendLanternist: Handler = async (ctx) => {
  const db = getDb();
  const input = ctx.job.input as { reviewLink?: boolean; pictures?: boolean };
  const key = await getProviderSecret(db, ctx.job.workspaceId, "lanternist");
  if (!key) throw new JobError("credentials_missing", "No Lanternist access token is set up.", false, "Add it in Settings → Lanternist.");
  const settings = LanternistSettings.parse(await getProviderSettings(db, ctx.job.workspaceId, "lanternist"));
  const { doc } = await getProject(db, ctx.job.projectId!, ctx.job.workspaceId);
  try {
    const r = await sendToLanternist(new McpHttpClient(settings.mcpUrl, key.secret), doc, { reviewLink: input.reviewLink !== false, pictures: !!input.pictures, onStage: (s) => ctx.stage(s) });
    return { ...r };
  } catch (e) {
    if (e instanceof McpError) {
      const recovery = { auth: "Check the Lanternist access token in Settings.", unavailable: "Check the Lanternist address in Settings and your connection.", timeout: "Try again in a moment.", protocol: "Check the Lanternist address in Settings; it should be Lanternist's MCP server.", tool: "Lanternist refused the request; check the film in Lanternist." }[e.code];
      throw new JobError(`lanternist_${e.code}`, `Lanternist: ${e.message}`, false, recovery);
    }
    throw e;
  }
};
