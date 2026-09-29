import { AppError, getDb, getProfile } from "@vs/db";
import { profileMarkdown } from "@vs/domain";
import { requireSession } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";

/** Optional Markdown explanation of a profile version (documentation, not instructions). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; version: string }> }) {
  try {
    const { id, version } = await ctx.params;
    const s = await requireSession();
    const { versions } = await getProfile(getDb(), id, s.workspaceId);
    const v = versions.find((x) => x.version === Number(version));
    if (!v) throw new AppError(404, "not_found", "Profile version not found.");
    const md = profileMarkdown(v.data, { version: v.version, evidence: (v.evidence as { traits?: never[] }).traits ?? [] });
    return new Response(md, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="profile-${id}-v${v.version}.md"`, "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
