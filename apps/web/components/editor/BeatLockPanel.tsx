"use client";
import { useState } from "react";
import { payoffScene, type ProjectDocument } from "@vs/domain";
import { api, ApiError } from "@/lib/client/api";
import type { JobDTO } from "./types";

type Report = { drop: { sec: number; label: string } | null; payoffScene: string; payoffSec: number; songStartSec: number; musicDelaySec: number; cutsMoved: number; bpm: number; conflicts: string[] };

/** Lock the video to its music: the song's drop lands on the payoff, every cut on a beat. */
export function BeatLockPanel({ projectId, doc, jobs }: { projectId: string; doc: ProjectDocument; jobs: JobDTO[] }) {
  const [payoff, setPayoff] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const music = doc.audio.find((t) => t.kind === "music");
  const mine = jobs.filter((j) => j.type === "lock_music");
  const running = mine.find((j) => ["queued", "running"].includes(j.status));
  const last = mine[0];
  const r = last?.status === "succeeded" ? (last.result as Report | null) : null;
  if (!music) return null;
  const auto = payoffScene(doc);
  return (
    <section className="space-y-2 text-xs" aria-labelledby="beatlock-h" data-testid="beat-lock">
      <h4 id="beatlock-h" className="label">Lock to the beat</h4>
      <p className="text-faint">Starts the song so its drop (the biggest lift in energy) lands on your payoff, then moves every cut onto a beat by whole beats, never stretching time. One undoable edit.</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          Land the drop on
          <select className="input py-0.5" aria-label="Payoff scene" value={payoff} onChange={(e) => setPayoff(e.target.value)}>
            <option value="">Auto: {auto.purpose}</option>
            {doc.scenes.map((s, i) => (
              <option key={s.id} value={s.id}>
                Scene {i + 1}: {s.purpose}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn"
          disabled={!!running}
          onClick={async () => {
            setErr(null);
            try {
              await api(`/api/projects/${projectId}/beatlock`, { method: "POST", idempotent: true, json: { trackId: music.id, ...(payoff ? { payoffSceneId: payoff } : {}) } });
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : String(e));
            }
          }}
        >
          {running ? `Locking… ${running.stage}` : "Lock to the beat"}
        </button>
      </div>
      {err && <p className="text-bad" role="alert">{err}</p>}
      {last?.status === "failed" && !running && <p className="text-bad">{last.error?.message} {last.error?.recovery}</p>}
      {r && !running && (
        <div className="space-y-1 text-dim" data-testid="beat-lock-result">
          <p>
            {r.drop ? `The drop (${r.drop.label}, ${r.drop.sec.toFixed(2)} s into the song)` : "A downbeat"} lands on “{r.payoffScene}” at {r.payoffSec.toFixed(2)} s. The song starts {r.songStartSec.toFixed(2)} s in{r.musicDelaySec ? `, ${r.musicDelaySec.toFixed(1)} s into the video` : ""}. {r.cutsMoved} {r.cutsMoved === 1 ? "cut" : "cuts"} moved onto the beat ({Math.round(r.bpm)} BPM).
          </p>
          {r.conflicts.map((c) => (
            <p key={c} className="text-warn">{c}</p>
          ))}
          <p className="text-faint">The analysis measures the music; it can't hear it. Play it back and check the drop feels right.</p>
        </div>
      )}
    </section>
  );
}
