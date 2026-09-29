import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, getProviderSecret, JobError, latestTranscriptForAsset, linkTranscriptToCollection, saveTranscript, schema, setItemState } from "@vs/db";
import { parseSubtitles } from "@vs/domain";
import { ElevenLabsStt, WhisperCppStt } from "@vs/providers";
import { resolveAssets, type Handler } from "../context";

const stem = (name: string) => basename(name, extname(name)).toLowerCase();

/**
 * Index one collection recording (FR-16). Order of preference, so unchanged files are never
 * transcribed twice (A20): an existing transcript for the same content hash → a matching
 * .srt/.vtt sidecar in the collection → a configured speech-to-text provider. Without any
 * of those the item is marked "needs_transcript" (visible, retryable), never faked.
 */
export const ingestCollectionItem: Handler = async (ctx) => {
  const db = getDb();
  const item = await db.query.collectionItems.findFirst({ where: and(eq(schema.collectionItems.id, String(ctx.job.input.itemId)), eq(schema.collectionItems.workspaceId, ctx.job.workspaceId)) });
  if (!item?.assetId) throw new JobError("not_found", "Collection item not found.", false);
  const asset = await db.query.assets.findFirst({ where: eq(schema.assets.id, item.assetId) });
  if (!asset || asset.status !== "ready") throw new JobError("asset_not_ready", "The recording hasn't finished uploading/processing.", true);
  if (asset.kind === "document") return { skipped: "subtitle sidecar" };
  if (asset.kind !== "video" && asset.kind !== "audio") throw new JobError("invalid_input", "Only audio and video recordings can be indexed.", false);
  const media = asset.media as { durationSec?: number; hasAudio?: boolean };
  await setItemState(db, item.id, { status: "probing", contentHash: asset.contentHash, durationSec: media.durationSec ?? null, error: null });
  if (!media.hasAudio) {
    await setItemState(db, item.id, { status: "failed", error: "No audio track to transcribe." });
    return { itemId: item.id, status: "failed" };
  }

  // 1) Same content already transcribed anywhere in the workspace: reuse, don't re-index.
  const existing = await latestTranscriptForAsset(db, asset.id, ctx.job.workspaceId);
  if (existing) {
    const linked = await linkTranscriptToCollection(db, existing.id, ctx.job.workspaceId, item.collectionId);
    await setItemState(db, item.id, { status: "indexed", transcriptId: existing.id });
    return { itemId: item.id, status: "indexed", reused: true, segmentsLinked: linked };
  }

  await ctx.stage("transcribing");
  await setItemState(db, item.id, { status: "transcribing" });
  // 2) Sidecar subtitles uploaded alongside (same file name stem).
  const siblings = await db.query.collectionItems.findMany({ where: eq(schema.collectionItems.collectionId, item.collectionId) });
  const sidecar = siblings.find((s) => s.id !== item.id && s.assetId && /\.(srt|vtt)$/i.test(s.sourceName) && stem(s.sourceName) === stem(item.sourceName));
  let result: { provider: string; granularity: "word" | "segment"; language: string | null; segments: { startSec: number; endSec: number; text: string }[] } | null = null;
  if (sidecar?.assetId) {
    const f = (await resolveAssets(ctx.job.workspaceId, [sidecar.assetId])).get(sidecar.assetId)!;
    result = { provider: "subtitle-import", granularity: "segment", language: null, segments: parseSubtitles(await readFile(f.path, "utf8")) };
  } else {
    // 3) A configured provider.
    const src = (await resolveAssets(ctx.job.workspaceId, [asset.id])).get(asset.id)!;
    const el = await getProviderSecret(db, ctx.job.workspaceId, "elevenlabs");
    if (el) result = await new ElevenLabsStt(el.secret).transcribe(src.path, { signal: ctx.signal });
    else if (WhisperCppStt.available()) result = await new WhisperCppStt().transcribe(src.path, { signal: ctx.signal, workDir: ctx.workDir });
  }
  if (!result) {
    await setItemState(db, item.id, { status: "needs_transcript", error: "No transcript yet: upload a matching .srt/.vtt, or connect speech-to-text in Settings, then index again." });
    return { itemId: item.id, status: "needs_transcript" };
  }
  await ctx.stage("indexing");
  const saved = await saveTranscript(db, { workspaceId: ctx.job.workspaceId, assetId: asset.id, provider: result.provider, language: result.language, granularity: result.granularity, segments: result.segments, collectionId: item.collectionId });
  await setItemState(db, item.id, { status: "indexed", transcriptId: saved.id });
  return { itemId: item.id, status: "indexed", reused: false, segments: saved.segments.length, provider: result.provider };
};
