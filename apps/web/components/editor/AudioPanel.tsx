"use client";
import { useEffect, useState } from "react";
import type { AudioTrack, Operation, ProjectDocument } from "@vs/domain";
import { AssetPicker } from "@/components/AssetPicker";
import { api, ApiError } from "@/lib/client/api";
import { NumberField } from "./fields";
import { newClientId } from "./ids";
import { MarkersPanel } from "./MarkersPanel";
import type { JobDTO } from "./types";

export function AudioPanel({ projectId, doc, apply, jobs }: { projectId: string; doc: ProjectDocument; apply: (ops: Operation[]) => Promise<boolean>; jobs: { type: string; status: string; stage: string; progress: number | null; result: Record<string, unknown> | null; error: { message: string } | null }[] }) {
  const music = doc.audio.filter((t) => t.kind === "music");
  return (
    <div className="space-y-4">
      <NarrationControls projectId={projectId} doc={doc} jobs={jobs} />
      <MarkersPanel projectId={projectId} doc={doc} jobs={jobs as JobDTO[]} apply={apply} />
      <p className="text-xs text-dim">The mix targets −16 LUFS integrated and −1 dBTP; each render records the measured result. Music ducks under narration and source speech.</p>
      {doc.audio.length === 0 && <p className="text-sm text-faint">No audio tracks. Add music below.</p>}
      <ul className="space-y-2">
        {doc.audio.map((t) => (
          <TrackEditor key={t.id} t={t} doc={doc} apply={apply} />
        ))}
      </ul>
      <div>
        <h4 className="label">{music.length ? "Replace music" : "Add music"}</h4>
        <AssetPicker
          kind="audio"
          value={music[0] ? [music[0].assetId] : []}
          onChange={(ids) => {
            const id = ids[0];
            if (!id) return music[0] && apply([{ op: "removeAudioTrack", trackId: music[0].id }]);
            if (music[0]) return apply([{ op: "updateAudioTrack", trackId: music[0].id, patch: { assetId: id, sourceInSec: 0, sourceOutSec: null } }]);
            return apply([{ op: "addAudioTrack", track: { id: newClientId("trk"), kind: "music", assetId: id, anchor: { type: "absolute", startFrame: 0 }, sourceInSec: 0, sourceOutSec: null, gainDb: -6, fadeInFrames: 0, fadeOutFrames: 45, duck: { enabled: true, amountDb: -12 } } }]);
          }}
        />
      </div>
    </div>
  );
}

function TrackEditor({ t, doc, apply }: { t: AudioTrack; doc: ProjectDocument; apply: (ops: Operation[]) => Promise<boolean> }) {
  const scene = t.anchor.type === "scene" ? doc.scenes.find((s) => s.id === (t.anchor as { sceneId: string }).sceneId) : undefined;
  return (
    <li className="card space-y-2 p-2.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium capitalize">{t.kind}</span>
        <span className="text-faint">{t.anchor.type === "absolute" ? `starts at ${(t.anchor.startFrame / 30).toFixed(1)}s (fixed)` : `anchored to “${scene?.purpose ?? "deleted scene"}” (moves with it)`}</span>
        {t.kind !== "source" && (
          <button className="btn btn-ghost ml-auto px-2 py-0.5 text-[11px] text-bad" onClick={() => apply([{ op: "removeAudioTrack", trackId: t.id }])}>
            Remove
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Gain</label>
          <NumberField value={t.gainDb} step={1} min={-60} max={12} suffix="dB" onCommit={(v) => apply([{ op: "setTrackGain", trackId: t.id, gainDb: v }])} />
        </div>
        <div>
          <label className="label">Source start (trim)</label>
          <NumberField value={t.sourceInSec} step={0.1} min={0} suffix="s" onCommit={(v) => apply([{ op: "updateAudioTrack", trackId: t.id, patch: { sourceInSec: v } }])} />
        </div>
        <div>
          <label className="label">Fade in</label>
          <NumberField value={t.fadeInFrames / 30} step={0.1} min={0} max={10} suffix="s" onCommit={(v) => apply([{ op: "updateAudioTrack", trackId: t.id, patch: { fadeInFrames: Math.round(v * 30) } }])} />
        </div>
        <div>
          <label className="label">Fade out</label>
          <NumberField value={t.fadeOutFrames / 30} step={0.1} min={0} max={10} suffix="s" onCommit={(v) => apply([{ op: "updateAudioTrack", trackId: t.id, patch: { fadeOutFrames: Math.round(v * 30) } }])} />
        </div>
        {t.kind === "music" && (
          <label className="col-span-2 flex items-center gap-2">
            <input type="checkbox" checked={t.duck.enabled} onChange={(e) => apply([{ op: "updateAudioTrack", trackId: t.id, patch: { duck: { ...t.duck, enabled: e.target.checked } } }])} />
            Duck under speech by
            <NumberField value={t.duck.amountDb} step={1} min={-30} max={0} suffix="dB" onCommit={(v) => apply([{ op: "updateAudioTrack", trackId: t.id, patch: { duck: { ...t.duck, amountDb: v } } }])} />
          </label>
        )}
      </div>
    </li>
  );
}

function NarrationControls({ projectId, doc, jobs }: { projectId: string; doc: ProjectDocument; jobs: { type: string; status: string; stage: string; progress: number | null; result: Record<string, unknown> | null; error: { message: string } | null }[] }) {
  const [voices, setVoices] = useState<{ id: string; label: string }[]>([]);
  const [voice, setVoice] = useState("");
  const [rate, setRate] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ voices: { id: string; label: string }[] }>("/api/voices").then((r) => {
      setVoices(r.voices);
      setVoice((v) => v || r.voices[0]?.id || "");
    });
  }, []);
  const scripted = doc.scenes.filter((s) => s.script.narration.trim());
  const voiced = new Set(doc.audio.filter((t) => t.kind === "voiceover" && t.anchor.type === "scene").map((t) => (t.anchor as { sceneId: string }).sceneId));
  const running = jobs.find((j) => j.type === "tts" && ["queued", "running"].includes(j.status));
  const last = jobs.find((j) => j.type === "tts" && ["succeeded", "failed"].includes(j.status));
  return (
    <section className="card space-y-2 p-2.5 text-xs">
      <h4 className="font-medium">Narration</h4>
      <p className="text-faint">{scripted.length} scene(s) have a script; {scripted.filter((s) => voiced.has(s.id)).length} have narration audio. Edited scripts are re-synthesised; unchanged ones are reused.</p>
      {voices.length === 0 ? (
        <p className="text-warn">No voices available: no worker with local TTS is online and no hosted TTS provider is configured.</p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label>
            <span className="label">Voice</span>
            <select className="input" value={voice} onChange={(e) => setVoice(e.target.value)}>
              {voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </label>
          <label>
            <span className="label">Rate ×{rate.toFixed(2)}</span>
            <input type="range" min={0.8} max={1.25} step={0.05} value={rate} onChange={(e) => setRate(Number(e.target.value))} />
          </label>
          <button
            className="btn btn-primary text-xs"
            disabled={!!running || !scripted.length}
            onClick={async () => {
              setErr(null);
              try {
                await api(`/api/projects/${projectId}/narration`, { method: "POST", idempotent: true, json: { voiceId: voice, rate, fit: "extend" } });
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : String(e));
              }
            }}
          >
            {running ? `Narrating… ${running.stage}` : "Generate narration + captions"}
          </button>
        </div>
      )}
      <p className="text-faint">Local voices run on your worker (compute, no provider bill) and sound synthetic. Captions are timed to the measured narration per phrase, not per word.</p>
      {last?.status === "failed" && <p className="text-bad">{last.error?.message}</p>}
      {last?.status === "succeeded" && Array.isArray(last.result?.scenes) && (
        <ul className="text-faint">
          {(last.result!.scenes as { sceneId: string; durationSec: number; reused: boolean; extendedBySec?: number; warning?: string }[]).map((r) => (
            <li key={r.sceneId}>
              {doc.scenes.find((s) => s.id === r.sceneId)?.purpose ?? r.sceneId}: {r.durationSec.toFixed(1)}s {r.reused ? "(reused)" : ""} {r.extendedBySec ? `· scene extended by ${r.extendedBySec.toFixed(1)}s` : ""} {r.warning ? <span className="text-warn">{r.warning}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {err && <p role="alert" className="text-bad">{err}</p>}
    </section>
  );
}
