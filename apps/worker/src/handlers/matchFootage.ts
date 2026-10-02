import { getDb, getProject, getProviderSecret } from "@vs/db";
import { FOOTAGE_SOURCES, footageAdapter, rankFootage, runFootageQueries, sceneSearchWords, searchLadder, type FootageAdapter, type FootageItem, type FootageQuery, type FootageScene, type FootageSearchParams } from "@vs/providers";
import type { Handler } from "../context";
import { claudeFor, noteLimit, recordUsage } from "./ai";

/**
 * Suggest background footage for every scene: Claude writes a visual search per scene (or the
 * scene's own words when Claude is off), each free source is searched, and the top results are
 * ranked for this video. Nothing is imported or placed; the owner picks in the Scene tab.
 */
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One search with a short pause first and one retry: free sources refuse rapid bursts. */
async function searchPolitely(a: FootageAdapter, p: FootageSearchParams, cache: Map<string, FootageItem[]>): Promise<{ items: FootageItem[] } | { error: string }> {
  const key = `${a.source}|${p.kind}|${p.q.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return { items: hit };
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    await pause(attempt ? 4000 : 400);
    try {
      const items = (await a.search(p)).items;
      cache.set(key, items);
      return { items };
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 200) : String(e);
    }
  }
  console.error("[worker] footage search failed", a.source, p.q, error);
  return { error };
}

export const matchFootage: Handler = async (ctx) => {
  const db = getDb();
  const projectId = ctx.job.projectId!;
  const { doc } = await getProject(db, projectId, ctx.job.workspaceId);
  const scenes: FootageScene[] = doc.scenes.map((s) => {
    const head = s.layers.find((l) => l.kind === "text" && (l.role === "headline" || l.role === "kicker") && l.text.trim());
    return { id: s.id, purpose: s.purpose, headline: head && head.kind === "text" ? head.text : "", narration: s.script.narration };
  });

  await ctx.stage("Claude is choosing what to search for");
  let queries: FootageQuery[] = [];
  let via: "claude" | "words" = "words";
  try {
    const run = await runFootageQueries(await claudeFor(ctx.job.workspaceId, projectId), { title: doc.title, aspect: doc.format.aspect, scenes }, { signal: ctx.signal });
    await noteLimit(ctx.job.workspaceId, null, run.usage);
    await recordUsage(ctx.job.workspaceId, projectId, ctx.job.id, run.usage, "footage-queries");
    queries = run.queries;
    via = "claude";
  } catch (e) {
    // Claude off, at its limit or failing: the scenes' own words still give useful results.
    await noteLimit(ctx.job.workspaceId, e);
  }
  const bySceneQuery = new Map(queries.map((q) => [q.sceneId, q]));

  const adapters = [];
  for (const s of FOOTAGE_SOURCES) {
    const key = s.keyProvider ? (await getProviderSecret(db, ctx.job.workspaceId, s.keyProvider))?.secret : undefined;
    if (!s.needsKey || key) adapters.push(footageAdapter(s.id, { apiKey: key, timeoutMs: 15_000 }));
  }

  const cache = new Map<string, FootageItem[]>();
  const out = [];
  for (const [i, scene] of scenes.entries()) {
    if (ctx.signal.aborted) break;
    const q = bySceneQuery.get(scene.id) ?? { sceneId: scene.id, query: sceneSearchWords(scene), kind: "video" as const };
    await ctx.stage(`searching footage for scene ${i + 1} of ${scenes.length}`, i / scenes.length);
    const sceneSec = (doc.scenes[i]!.durationFrames ?? 90) / doc.format.fps;
    const failed = new Map<string, string>();
    const picked = new Map<string, FootageItem>();
    let used = q.query;
    // Widen the search until there are enough usable results (libraries match every word).
    // Results from a more specific search always come before those from a wider one.
    for (const search of searchLadder(q)) {
      const step: FootageItem[] = [];
      for (const a of adapters) {
        const r = await searchPolitely(a, { q: search, kind: q.kind, perPage: 8, openOnly: true }, cache);
        if ("items" in r) step.push(...r.items);
        else failed.set(a.source, r.error);
      }
      for (const f of rankFootage(step, { aspect: doc.format.aspect, sceneSec })) if (!picked.has(`${f.source}:${f.id}`)) picked.set(`${f.source}:${f.id}`, f);
      used = search;
      if (picked.size >= 4) break;
    }
    const candidates = [...picked.values()]
      .slice(0, 4)
      .map((c) => ({ source: c.source, id: c.id, kind: c.kind, title: c.title.slice(0, 120), thumbUrl: c.thumbUrl, pageUrl: c.pageUrl, license: c.license.name, durationSec: c.durationSec ?? null, width: c.width ?? null, height: c.height ?? null }));
    out.push({ sceneId: scene.id, query: used, kind: q.kind, candidates, ...(failed.size ? { unavailable: [...failed].map(([source, error]) => ({ source, error })) } : {}) });
  }
  return { via, scenes: out };
};
