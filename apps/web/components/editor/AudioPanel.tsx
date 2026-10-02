"use client";
import { useEffect, useState } from "react";
import { computeTimeline, DIRECTION_SUPPORT, voiceKind } from "@vs/domain";
import type { AudioTrack, Operation, ProjectDocument } from "@vs/domain";
import { AssetPicker } from "@/components/AssetPicker";
import { api, ApiError } from "@/lib/client/api";
import { NumberField } from "./fields";
import { newClientId } from "./ids";
import { MarkersPanel } from "./MarkersPanel";
import { SoundEffectsPanel } from "./SoundEffectsPanel";
import { BeatLockPanel } from "./BeatLockPanel";
import type { JobDTO } from "./types";

export function AudioPanel({ projectId, doc, apply, jobs }: { projectId: string; doc: ProjectDocument; apply: (ops: Operation[]) => Promise<boolean>; jobs: { type: string; status: string; stage: string; progress: number | null; result: Record<string, unknown> | null; error: { message: string; recovery?: string } | null }[] }) {
  const music = doc.audio.filter((t) => t.kind === "music");
  return (
    <div className="space-y-4">
      <NarrationControls projectId={projectId} doc={doc} jobs={jobs} />
      <MarkersPanel projectId={projectId} doc={doc} jobs={jobs as JobDTO[]} apply={apply} />
      <p className="text-xs text-dim">The mix targets −16 LUFS integrated and −1 dBTP; each render records the measured result. Music ducks under narration and source speech.</p>
      {doc.audio.length === 0 && <p className="text-sm text-faint">No audio tracks. Add music below.</p>}
      <ul className="space-y-2">
        {doc.audio
          .filter((t) => !t.sfx)
          .map((t) => (
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
      <MusicGenerator projectId={projectId} doc={doc} jobs={jobs} hasMusic={music.length > 0} />
      <BeatLockPanel projectId={projectId} doc={doc} jobs={jobs as JobDTO[]} />
      <SoundEffectsPanel projectId={projectId} doc={doc} apply={apply} jobs={jobs as JobDTO[]} />
    </div>
  );
}

/** Compose a bed with ElevenLabs Music: paid, budget-checked, and placed on the timeline (replacing the current music). */
function MusicGenerator({ projectId, doc, jobs, hasMusic }: { projectId: string; doc: ProjectDocument; jobs: { type: string; status: string; stage: string; result: Record<string, unknown> | null; error: { message: string; recovery?: string } | null }[]; hasMusic: boolean }) {
  const total = Math.ceil(computeTimeline(doc).totalFrames / doc.format.fps);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [prompt, setPrompt] = useState(() => `${doc.brand.tone ? `${doc.brand.tone}, ` : ""}modern instrumental bed for a ${doc.template.family.replace(/-/g, " ")} video about ${doc.brand.name || doc.title}. Steady tempo, clean mix that sits under a voiceover, builds slightly towards the end.`);
  const [length, setLength] = useState(Math.max(3, total + 1));
  const [instrumental, setInstrumental] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ elevenlabs: { configured: boolean } }>("/api/voices").then((r) => setConfigured(r.elevenlabs.configured)).catch(() => setConfigured(false));
  }, []);
  const job = jobs.find((j) => j.type === "generate_music");
  const active = job && ["queued", "running"].includes(job.status);
  return (
    <section className="card space-y-2 p-2.5 text-xs" aria-label="Generate music">
      <h4 className="font-medium">Generate music (ElevenLabs)</h4>
      {configured === false ? (
        <p className="text-faint">Add your ElevenLabs key in Settings → Provider keys to compose music from a description.</p>
      ) : (
        <>
          <textarea className="input min-h-16" aria-label="Music description" maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5">
              Length
              <input className="input h-7 w-16 px-2 py-0" type="number" min={3} max={600} aria-label="Music length (seconds)" value={length} onChange={(e) => setLength(Number(e.target.value))} />s
            </label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={instrumental} onChange={(e) => setInstrumental(e.target.checked)} /> Instrumental</label>
            <button
              className="btn btn-primary ml-auto px-3 text-xs"
              disabled={!!active || prompt.trim().length < 3 || !(length >= 3 && length <= 600)}
              onClick={async () => {
                setErr(null);
                try {
                  await api(`/api/projects/${projectId}/music`, { method: "POST", idempotent: true, json: { prompt: prompt.trim(), durationSec: length, instrumental, replace: true } });
                } catch (e) {
                  setErr(e instanceof ApiError ? `${e.message}${e.recovery ? ` — ${e.recovery}` : ""}` : String(e));
                }
              }}
            >
              {active ? `Composing… ${job!.stage}` : hasMusic ? "Compose & replace music" : "Compose music"}
            </button>
          </div>
          <p className="text-faint">Billed by ElevenLabs from your plan and checked against this project&apos;s budget first (enter your price per minute in Settings, or authorise unknown-price requests in the Project tab). Runs once — never retried automatically. Length is measured from the returned audio.</p>
          {job?.status === "succeeded" && <p className="text-ok" data-testid="music-result">Added {Number(job.result?.measuredSec ?? 0).toFixed(1)}s of music to the timeline.</p>}
          {job?.status === "failed" && <p className="text-bad" role="alert">{job.error?.message} {job.error?.recovery}</p>}
          {err && <p className="text-bad" role="alert">{err}</p>}
        </>
      )}
    </section>
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
  const [voices, setVoices] = useState<{ id: string; label: string; kind?: string }[]>([]);
  const [omni, setOmni] = useState<{ configured: boolean; reachable?: boolean; message?: string } | null>(null);
  const [eleven, setEleven] = useState<{ configured: boolean; reachable?: boolean; message?: string } | null>(null);
  const [voice, setVoice] = useState("");
  const [rate, setRate] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    type Status = { configured: boolean; reachable?: boolean; message?: string };
    api<{ voices: { id: string; label: string; kind?: string }[]; omnivoice?: Status; elevenlabs?: Status }>("/api/voices").then((r) => {
      setVoices(r.voices);
      setOmni(r.omnivoice ?? null);
      setEleven(r.elevenlabs ?? null);
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
      {omni?.configured && omni.reachable === false && <p className="text-warn">OmniVoice voices are unavailable: {omni.message}</p>}
      {eleven?.configured && eleven.reachable === false && <p className="text-warn">ElevenLabs voices are unavailable: {eleven.message}</p>}
      {voice.startsWith("elevenlabs:") && <p className="text-faint">ElevenLabs bills your ElevenLabs account per character; scenes whose script hasn&apos;t changed are reused and cost nothing.</p>}
      {voices.length === 0 ? (
        <p className="text-warn">No voices available: no worker with local TTS is online and no hosted TTS provider is configured.</p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label>
            <span className="label">Voice</span>
            <select className="input" value={voice} onChange={(e) => setVoice(e.target.value)}>
              {voices.some((v) => v.kind === "omnivoice") && (
                <optgroup label="OmniVoice (on this computer)">
                  {voices.filter((v) => v.kind === "omnivoice").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                </optgroup>
              )}
              {voices.some((v) => v.kind === "elevenlabs") && (
                <optgroup label="ElevenLabs (billed per character by ElevenLabs)">
                  {voices.filter((v) => v.kind === "elevenlabs").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                </optgroup>
              )}
              <optgroup label="Built-in">
                {voices.filter((v) => v.kind !== "omnivoice" && v.kind !== "elevenlabs").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </optgroup>
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
      {(() => {
        const directed = doc.scenes.filter((s) => s.script.narration.trim() && s.script.direction).length;
        return directed > 0 && voice ? (
          <p className="mt-1 text-[11px] text-faint" data-testid="direction-note">
            {directed} line{directed > 1 ? "s have" : " has"} delivery direction (set per scene). {DIRECTION_SUPPORT[voiceKind(voice)].how}
          </p>
        ) : null;
      })()}
      <p className="text-faint">Built-in voices run on your worker (compute, no provider bill) and sound synthetic; OmniVoice voices also run on your computer, through your OmniVoice server. Captions are timed to the measured narration per phrase, not per word.</p>
      {last?.status === "failed" && <p className="text-bad">{last.error?.message} {(last.error as { recovery?: string } | null)?.recovery && <span className="text-dim">{(last.error as { recovery?: string }).recovery}</span>}</p>}
      {last?.status === "succeeded" && last.result?.provider === "elevenlabs" && (
        <p className="text-dim">{Number(last.result.charactersSynthesized ?? 0).toLocaleString()} characters sent to ElevenLabs in the last run.</p>
      )}
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
