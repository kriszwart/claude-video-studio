"use client";
import { useState } from "react";
import type { Operation, ProjectDocument } from "@vs/domain";
import { FootageSearch } from "@/components/FootageSearch";
import { api, ApiError, waitForJob } from "@/lib/client/api";

type Candidate = { source: string; id: string; kind: "video" | "image"; title: string; thumbUrl: string | null; pageUrl: string; license: string; durationSec: number | null; width: number | null; height: number | null };
type SceneMatch = { sceneId: string; query: string; kind: "video" | "image"; candidates: Candidate[]; unavailable?: { source: string; error: string }[]; pick?: { best: boolean; reason: string } };

/**
 * "Match footage for every scene": Claude writes a visual search per scene, the free sources
 * are searched, and each scene shows ranked candidates. Picking one imports it (licence kept)
 * and makes it that scene's background; nothing changes until the owner picks.
 */
export function MatchFootage({ projectId, doc, apply }: { projectId: string; doc: ProjectDocument; apply: (ops: Operation[]) => Promise<boolean> }) {
  const [matches, setMatches] = useState<SceneMatch[] | null>(null);
  const [via, setVia] = useState<"claude" | "words" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState<string | null>(null);

  const find = async () => {
    setBusy("find");
    setStatus("starting…");
    try {
      const r = await api<{ job: { id: string } }>(`/api/projects/${projectId}/footage-matches`, { method: "POST", idempotent: true });
      const done = await waitForJob(r.job.id, (j) => setStatus(j.stage));
      if (done.status !== "succeeded") throw new ApiError(422, done.error?.code ?? "failed", done.error?.message ?? "Footage search failed.");
      const res = done.result as { via: "claude" | "words"; scenes: SceneMatch[] };
      setMatches(res.scenes);
      setVia(res.via);
      setStatus(null);
    } catch (e) {
      setStatus(`failed: ${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const setBackground = async (sceneId: string, assetId: string) => {
    const ok = await apply([{ op: "setSceneBackground", sceneId, background: { type: "asset", assetId, dim: 0.45, blur: 0 } }]);
    if (ok) setChosen((c) => ({ ...c, [sceneId]: assetId }));
    return ok;
  };

  const pick = async (sceneId: string, c: Candidate) => {
    setBusy(`${sceneId}:${c.source}:${c.id}`);
    try {
      const n = doc.scenes.findIndex((s) => s.id === sceneId) + 1;
      // Free sources limit bursts of requests: wait and try again rather than failing.
      let r: { job: { id: string } } | null = null;
      for (let attempt = 0; !r; attempt++) {
        try {
          r = await api<{ job: { id: string } }>("/api/footage/import", { method: "POST", json: { source: c.source, id: c.id, kind: c.kind, rightsAcknowledged: true } });
        } catch (e) {
          if (!(e instanceof ApiError && e.code === "footage_rate_limited") || attempt >= 3) throw e;
          setStatus(`Scene ${n}: the footage service asked us to slow down; trying again in 20 s…`);
          await new Promise((res) => setTimeout(res, 20_000));
        }
      }
      setStatus(`Scene ${n}: importing…`);
      const done = await waitForJob(r.job.id);
      const assetId = String((done.result as { assetId?: string } | null)?.assetId ?? "");
      if (done.status !== "succeeded" || !assetId) throw new ApiError(422, done.error?.code ?? "failed", done.error?.message ?? "Import failed.");
      await setBackground(sceneId, assetId);
      setStatus(null);
    } catch (e) {
      setStatus(`Scene ${doc.scenes.findIndex((s) => s.id === sceneId) + 1}: ${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // Scenes Claude found no good match for are left for the owner (search again or generate).
  const pickAll = async () => {
    for (const m of matches ?? []) if (m.candidates[0] && !chosen[m.sceneId] && m.pick?.best !== false) await pick(m.sceneId, m.candidates[0]);
  };

  /** A picture made with the owner's ChatGPT plan when no footage fits (Images with ChatGPT). */
  const generate = async (m: SceneMatch) => {
    const index = doc.scenes.findIndex((s) => s.id === m.sceneId);
    const scene = doc.scenes[index]!;
    const words = scene.layers.find((l) => l.kind === "text" && (l.role === "headline" || l.role === "kicker"));
    const prompt = [
      `A cinematic background picture for scene ${index + 1} of a short video titled "${doc.title}".`,
      `Show: ${m.query}.`,
      words && words.kind === "text" ? `The scene's on-screen words are "${words.text}"; show the idea, never write the words.` : "",
      scene.script.narration ? `Narration: ${scene.script.narration.slice(0, 300)}` : "",
      "No text, no logos, no watermarks. Leave calm space for on-screen text.",
    ].filter(Boolean).join(" ");
    setBusy(`gen:${m.sceneId}`);
    setStatus(`Scene ${index + 1}: generating with ChatGPT (about a minute)…`);
    try {
      const r = await api<{ job: { id: string } }>("/api/assets/generate-image", { method: "POST", idempotent: true, json: { prompt, aspectRatio: doc.format.aspect } });
      const done = await waitForJob(r.job.id, (j) => setStatus(`Scene ${index + 1}: ${j.stage}`));
      const assetId = String((done.result as { assetId?: string } | null)?.assetId ?? "");
      if (done.status !== "succeeded" || !assetId) throw new ApiError(422, done.error?.code ?? "failed", `${done.error?.message ?? "Generation failed."}${done.error?.recovery ? ` ${done.error.recovery}` : ""}`);
      await setBackground(m.sceneId, assetId);
      setStatus(null);
    } catch (e) {
      setStatus(`Scene ${index + 1}: ${e instanceof ApiError ? `${e.message}${e.recovery ? ` ${e.recovery}` : ""}` : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="card p-2.5 text-xs" open={!!matches}>
      <summary className="cursor-pointer text-sm font-medium">Match footage for every scene</summary>
      <p className="mt-1 text-faint">Claude picks what to search for in each scene, free footage is found on Wikimedia Commons, Internet Archive, Pexels and Pixabay (the last two need free keys in Settings), and Claude looks at the results and puts the best fit first. Click a result to make it that scene&apos;s background; its licence is kept in your library and listed in Export → Credits.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary text-xs" disabled={!!busy} onClick={find}>{busy === "find" ? "Searching…" : matches ? "Search again" : "Find footage for all scenes"}</button>
        {matches && matches.some((m) => m.candidates.length && !chosen[m.sceneId] && m.pick?.best !== false) && (
          <button type="button" className="btn text-xs" disabled={!!busy} onClick={pickAll}>Use top pick for every scene</button>
        )}
        {status && <span className="text-dim" role="status">{status}</span>}
      </div>
      {via === "words" && <p className="mt-1 text-warn">Claude was unavailable, so each scene was searched with its own words.</p>}
      {matches && (
        <ol className="mt-3 space-y-3">
          {matches.map((m) => {
            const index = doc.scenes.findIndex((s) => s.id === m.sceneId);
            const scene = doc.scenes[index];
            if (!scene) return null;
            return (
              <li key={m.sceneId} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <strong>{index + 1}. {scene.purpose}</strong>
                  <span className="text-faint">“{m.query}”</span>
                  {chosen[m.sceneId] && <span className="chip text-ok">background set</span>}
                  <button type="button" className="ml-auto underline text-faint hover:text-ink" onClick={() => setSearching(searching === m.sceneId ? null : m.sceneId)}>{searching === m.sceneId ? "close" : "search differently"}</button>
                  <button type="button" className={`underline hover:text-ink ${m.pick?.best === false || !m.candidates.length ? "text-accent" : "text-faint"}`} disabled={!!busy} onClick={() => void generate(m)}>{busy === `gen:${m.sceneId}` ? "generating…" : "generate with ChatGPT"}</button>
                </div>
                {m.candidates.length === 0 && <p className="text-faint">Nothing usable found. Search differently or generate a picture.</p>}
                {m.pick?.best === false && <p className="text-warn">No good match: {m.pick.reason || "none of these fit the scene"}. Search differently or generate a picture.</p>}
                {m.pick?.best && m.pick.reason && <p className="text-faint">Claude&apos;s pick: {m.pick.reason}</p>}
                <div className="grid grid-cols-4 gap-1.5">
                  {m.candidates.map((c) => {
                    const key = `${m.sceneId}:${c.source}:${c.id}`;
                    return (
                      <button key={key} type="button" disabled={!!busy} title={`${c.title} — ${c.license}`} className="card overflow-hidden text-left hover:border-accent disabled:opacity-60" onClick={() => pick(m.sceneId, c)}>
                        <div className="relative aspect-video bg-bg">
                          {c.thumbUrl && <img src={c.thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" />}
                          {c.durationSec != null && <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[10px] text-white">{Math.round(c.durationSec)}s</span>}
                          {busy === key && <span className="absolute inset-0 grid place-items-center bg-black/60 text-[10px] text-white">importing…</span>}
                        </div>
                        <div className="truncate px-1 py-0.5 text-[10px] text-faint">{m.pick?.best && c === m.candidates[0] ? <span className="text-ok">Claude&apos;s pick · </span> : null}{c.license}</div>
                      </button>
                    );
                  })}
                </div>
                {m.unavailable?.length ? <p className="text-[10px] text-faint">{m.unavailable.map((u) => `${u.source}: ${u.error}`).join(" · ")}</p> : null}
                {searching === m.sceneId && (
                  <div className="card p-2">
                    <FootageSearch kind={m.kind} initialQuery={m.query} onImported={(assetId) => { setSearching(null); void setBackground(m.sceneId, assetId); }} />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </details>
  );
}
