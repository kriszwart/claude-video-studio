"use client";
import { useState } from "react";
import { validateTimeline, type Operation, type ProjectDocument } from "@vs/domain";
import { api, ApiError } from "@/lib/client/api";
import { NumberField } from "./fields";
import { newClientId } from "./ids";
import type { JobDTO } from "./types";

/**
 * Music markers (distinct from editorial beats): analysis proposals are unverified until
 * the owner confirms or moves them. Scene cuts can be fitted to them (music lock).
 */
export function MarkersPanel({ projectId, doc, jobs, apply }: { projectId: string; doc: ProjectDocument; jobs: JobDTO[]; apply: (ops: Operation[]) => Promise<boolean> }) {
  const [density, setDensity] = useState<"sections" | "downbeats" | "beats">("downbeats");
  const [show, setShow] = useState<"section" | "all">("section");
  const [msg, setMsg] = useState<string | null>(null);
  const fps = doc.format.fps;
  const music = doc.audio.find((t) => t.kind === "music");
  const running = jobs.find((j) => j.type === "analyze_music" && ["queued", "running"].includes(j.status));
  const last = jobs.find((j) => j.type === "analyze_music");
  const shown = doc.markers.filter((m) => show === "all" || m.kind === "section");
  const unverified = doc.markers.filter((m) => !m.verified);
  const musicIssues = validateTimeline(doc).filter((i) => i.code === "music_truncated" || i.code === "music_short");
  const analyse = async () => {
    setMsg(null);
    try {
      await api(`/api/projects/${projectId}/music-analysis`, { method: "POST", json: { density, trackId: music?.id } });
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    }
  };
  if (!music) return null;
  const result = last?.status === "succeeded" ? (last.result as { bpm?: number; tempoConfidence?: number } | null) : null;
  return (
    <section aria-labelledby="mk-h" className="space-y-2 text-xs">
      <h3 id="mk-h" className="text-sm font-medium">Music markers</h3>
      <p className="text-dim">Musical beats and sections (not editorial beats). Analysis proposes markers; moving or confirming one makes it yours.</p>
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-auto" aria-label="Marker density" value={density} onChange={(e) => setDensity(e.target.value as typeof density)}>
          <option value="sections">Sections only</option>
          <option value="downbeats">Sections + downbeats</option>
          <option value="beats">Every beat</option>
        </select>
        <button className="btn text-xs" disabled={!!running} onClick={analyse}>
          {running ? `Analysing… ${running.stage}` : "Analyse music"}
        </button>
        {result?.bpm && <span className="chip">{result.bpm} BPM{(result.tempoConfidence ?? 1) < 0.5 ? " (low confidence)" : ""}</span>}
        {last?.status === "failed" && <span className="text-bad">{last.error?.message}</span>}
        {msg && <span className="text-bad">{msg}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn text-xs" disabled={!doc.markers.some((m) => m.kind === "section")} onClick={() => apply([{ op: "fitScenesToMarkers", kinds: ["section"] }])}>
          Fit cuts to sections
        </button>
        <button className="btn text-xs" disabled={!doc.markers.some((m) => m.kind === "downbeat")} onClick={() => apply([{ op: "fitScenesToMarkers", kinds: ["downbeat", "section"] }])}>
          Fit cuts to downbeats
        </button>
        {unverified.length > 0 && (
          <button className="btn btn-ghost text-xs" onClick={() => apply([{ op: "verifyMarkers", markerIds: unverified.map((m) => m.id) }])}>
            Confirm {unverified.length} proposed
          </button>
        )}
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={doc.musicAccents.enabled} onChange={(e) => apply([{ op: "setMusicAccents", accents: { enabled: e.target.checked } }])} />
        Visual accents on
        <select className="input w-auto py-0.5" aria-label="Accent markers" value={doc.musicAccents.on} onChange={(e) => apply([{ op: "setMusicAccents", accents: { on: e.target.value as "downbeat" } }])}>
          <option value="downbeat">downbeats</option>
          <option value="beat">beats</option>
          <option value="section">sections</option>
        </select>
      </label>
      {musicIssues.map((i) => (
        <p key={i.code} className="text-warn">{i.message}</p>
      ))}
      <div className="flex items-center gap-2">
        <span className="text-faint">{doc.markers.length} markers</span>
        <select className="input ml-auto w-auto py-0.5" aria-label="Show markers" value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
          <option value="section">Sections</option>
          <option value="all">All</option>
        </select>
        <button className="btn btn-ghost px-2 py-0.5 text-[11px]" onClick={() => apply([{ op: "addMarker", marker: { id: newClientId("mk"), frame: 0, kind: "section", label: "new section", verified: true } }])}>
          + Section
        </button>
      </div>
      <ul className="max-h-64 space-y-1 overflow-y-auto" aria-label="Markers">
        {shown.map((m) => (
          <li key={m.id} className="flex items-center gap-2" data-testid={`marker-${m.kind}`}>
            <span className={`chip ${m.verified ? "" : "opacity-60"}`} title={m.verified ? "Confirmed" : "Proposed by analysis"}>
              {m.kind}
              {m.label ? ` · ${m.label}` : ""}
            </span>
            <div className="w-24">
              <NumberField value={m.frame / fps} step={0.01} min={0} suffix="s" onCommit={(v) => apply([{ op: "moveMarker", markerId: m.id, frame: Math.round(v * fps) }])} />
            </div>
            {!m.verified && <span className="text-faint">proposed</span>}
            <button className="btn btn-ghost ml-auto px-1.5 py-0.5 text-[11px] text-bad" aria-label={`Remove marker at ${(m.frame / fps).toFixed(2)}s`} onClick={() => apply([{ op: "removeMarker", markerId: m.id }])}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
