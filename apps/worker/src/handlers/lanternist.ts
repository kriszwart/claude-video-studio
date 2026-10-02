import { getDb, getProviderSecret, getProviderSettings, getRevision, JobError, shareFile, ShareSettings } from "@vs/db";
import { ProjectDocument } from "@vs/domain";
import { LanternistSettings, McpError, McpHttpClient, sendToLanternist, type PictureSource } from "@vs/providers";
import { resolveAssets, type Handler } from "../context";
import { sceneFrames } from "./keyframes";

/** Frames sent to Lanternist: about 960 px wide for a 1920 px project. */
const PICTURE_SCALE = 0.5;

/**
 * Send to Lanternist: the project's shot plan becomes a Lanternist film (one shot per scene,
 * with timing, narration and an image prompt), optionally with a public review link and pictures.
 * Pictures are drawn by Lanternist (its credits) or are Fluxtify's own frames of each scene,
 * uploaded to the owner's picture hosting bucket so Lanternist can fetch them by address.
 * Nothing in the Fluxtify project changes.
 */
export const sendLanternist: Handler = async (ctx) => {
  const db = getDb();
  const input = ctx.job.input as { reviewLink?: boolean; pictures?: boolean | PictureSource };
  const pictures: PictureSource = input.pictures === true ? "lanternist" : !input.pictures ? "none" : input.pictures;
  const key = await getProviderSecret(db, ctx.job.workspaceId, "lanternist");
  if (!key) throw new JobError("credentials_missing", "No Lanternist access token is set up.", false, "Add it in Settings → Lanternist.");
  const settings = LanternistSettings.parse(await getProviderSettings(db, ctx.job.workspaceId, "lanternist"));
  const doc = ProjectDocument.parse((await getRevision(db, ctx.job.projectId!, ctx.job.revisionId!)).document);

  // Fluxtify's pictures are captured and uploaded first, so a hosting problem fails before a film exists.
  let pictureUrls: (string | null)[] | undefined;
  let linksExpire: string | null = null;
  if (pictures === "fluxtify") {
    const share = ShareSettings.safeParse(await getProviderSettings(db, ctx.job.workspaceId, "share"));
    const secret = await getProviderSecret(db, ctx.job.workspaceId, "share");
    if (!share.success || !secret) throw new JobError("share_not_configured", "Picture hosting isn't set up.", false, "Add your bucket in Settings → Picture hosting, or let Lanternist draw the pictures.");
    await ctx.stage("capturing a frame of each scene");
    const frames = await sceneFrames(ctx, ctx.job.revisionId!, PICTURE_SCALE);
    const files = await resolveAssets(ctx.job.workspaceId, frames.keyframes.map((k) => k.assetId));
    pictureUrls = [];
    for (const [i, k] of frames.keyframes.entries()) {
      await ctx.stage(`uploading picture ${i + 1} of ${frames.keyframes.length}`, i / frames.keyframes.length);
      const f = files.get(k.assetId);
      if (!f) {
        pictureUrls.push(null);
        continue;
      }
      try {
        const shared = await shareFile(share.data, secret.secret, f.path, "image/jpeg");
        pictureUrls.push(shared.url);
        linksExpire = shared.expiresAt;
      } catch (e) {
        throw new JobError("share_upload_failed", `Uploading pictures failed: ${(e as Error).message}`, false, "Check Settings → Picture hosting (Test connection), then try again.");
      }
    }
  }

  try {
    const r = await sendToLanternist(new McpHttpClient(settings.mcpUrl, key.secret), doc, { reviewLink: input.reviewLink !== false, pictures, pictureUrls, onStage: (s) => ctx.stage(s) });
    return { ...r, pictureSource: pictures, linksExpire };
  } catch (e) {
    if (e instanceof McpError) {
      const recovery = { auth: "Check the Lanternist access token in Settings.", unavailable: "Check the Lanternist address in Settings and your connection.", timeout: "Try again in a moment.", protocol: "Check the Lanternist address in Settings; it should be Lanternist's MCP server.", tool: "Lanternist refused the request; check the film in Lanternist." }[e.code];
      throw new JobError(`lanternist_${e.code}`, `Lanternist: ${e.message}`, false, recovery);
    }
    throw e;
  }
};
