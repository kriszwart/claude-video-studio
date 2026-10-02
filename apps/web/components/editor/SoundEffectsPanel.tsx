"use client";
import { useEffect, useState } from "react";
import { computeTimeline, resolveAnchor, SOUND_ROLE_LABEL, SOUND_ROLES, type AudioTrack, type Operation, type ProjectDocument, type SoundRole } from "@vs/domain";
import { AssetPicker } from "@/components/AssetPicker";
import { api, ApiError } from "@/lib/client/api";
import type { JobDTO } from "./types";

type KitEntry = { role: SoundRole; assetId: string; name: string; durationSec: number; hitSec: number | null; peakSec: number | null };

/**
 * Sound effects: the workspace's sound kit (one real recording per role, measured once) and the
 * effects placed on this project, each timed so its hit lands on its moment.
 */
export function SoundEffectsPanel({ projectId, doc, apply, jobs }: { projectId: string; doc: ProjectDocument; apply: (ops: Operation[]) => Promise<boolean>; jobs: JobDTO[] }) {
  const [kit, setKit] = useState<KitEntry[] | null>(null);
  const [density, setDensity] = useState(doc.profile.soundDensity);
  const [err, setErr] = useState<string | null>(null);
  const placed = doc.audio.filter((t) => t.sfx);
  const mine = jobs.filter((j) => j.type === "place_sfx");
  const running = mine.find((j) => ["queued", "running"].includes(j.status));
  const last = mine[0];
  useEffect(() => {
    api<{ kit: KitEntry[] }>("/api/sfx").then((r) => setKit(r.kit)).catch(() => setKit([]));
  }, [running?.status]);
  const tl = computeTimeline(doc);
  const fps = doc.format.fps;
  const setRole = async (role: SoundRole, assetId: string | null) => {
    setErr(null);
    try {
      setKit((await api<{ kit: KitEntry[] }>("/api/sfx", { method: "PUT", json: { role, assetId } })).kit);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <section className="space-y-2 text-xs" aria-labelledby="sfx-h" data-testid="sound-effects">
      <h4 id="sfx-h" className="label">Sound effects</h4>
      <p className="text-faint">Real recordings from your sound kit, placed on transitions, headlines, typed text and the call to action. Each sound is measured once, so it starts early enough for its loud part to land on the moment (a whoosh peaks late, a click hits at once).</p>
      <details className="card p-2" open={kit !== null && kit.length === 0}>
        <summary className="cursor-pointer">Sound kit ({kit?.length ?? 0} of {SOUND_ROLES.length} roles)</summary>
        <p className="mt-2 text-faint">Add short recordings (under 20 s) you have the rights to use, such as Mixkit&apos;s free sound effects. The kit is shared by all your projects.</p>
        <ul className="mt-2 space-y-2">
          {SOUND_ROLES.map((role) => {
            const e = kit?.find((k) => k.role === role);
            return (
              <li key={role} className="space-y-1" data-role={role}>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{SOUND_ROLE_LABEL[role]}</span>
                  {e ? (
                    <span className="text-dim" data-testid={`kit-${role}`}>
                      {e.name} · {e.durationSec.toFixed(1)} s{e.hitSec !== null ? ` · hits at ${Math.round(e.hitSec * 1000)} ms` : " · measured when placed"}
                    </span>
                  ) : (
                    <span className="text-faint">none</span>
                  )}
                  {e && (
                    <button className="btn btn-ghost ml-auto px-2 py-0.5 text-[11px]" onClick={() => void setRole(role, null)}>
                      Remove
                    </button>
                  )}
                </div>
                <details>
                  <summary className="cursor-pointer text-dim">{e ? "Replace" : "Choose a sound"}</summary>
                  <AssetPicker kind="audio" value={e ? [e.assetId] : []} onChange={(ids) => void setRole(role, ids[0] ?? null)} />
                </details>
              </li>
            );
          })}
        </ul>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          How many
          <select className="input py-0.5" aria-label="Sound effect density" value={density} onChange={(e) => setDensity(e.target.value as typeof density)}>
            <option value="minimal">Few (transitions and call to action)</option>
            <option value="moderate">Some (plus headlines and typing)</option>
            <option value="rich">Many (plus every item)</option>
          </select>
        </label>
        <button
          className="btn"
          disabled={!kit?.length || !!running}
          onClick={async () => {
            setErr(null);
            try {
              await api(`/api/projects/${projectId}/sfx`, { method: "POST", idempotent: true, json: { density } });
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : String(e));
            }
          }}
        >
          {running ? `Placing… ${running.stage}` : placed.length ? "Re-place sound effects" : "Add sound effects"}
        </button>
        {placed.length > 0 && !running && (
          <button className="btn btn-ghost text-bad" onClick={() => void apply(placed.map((t) => ({ op: "removeAudioTrack", trackId: t.id })))}>
            Remove all
          </button>
        )}
      </div>
      {err && <p className="text-bad" role="alert">{err}</p>}
      {last?.status === "failed" && !running && <p className="text-bad">{last.error?.message} {last.error?.recovery}</p>}
      {last?.status === "succeeded" && !running && Array.isArray((last.result as { skipped?: unknown[] } | null)?.skipped) && (last.result as { skipped: { why: string }[] }).skipped.some((x) => x.why.startsWith("no sound")) && (
        <p className="text-faint">Some moments got no sound because their role has nothing in the kit.</p>
      )}
      {placed.length > 0 && (
        <ol className="space-y-1" data-testid="placed-effects">
          {placed
            .map((t) => ({ t, at: resolveAnchor(t.anchor, tl) }))
            .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
            .map(({ t, at }) => (
              <PlacedEffect key={t.id} t={t} at={at} fps={fps} kit={kit} apply={apply} />
            ))}
        </ol>
      )}
    </section>
  );
}

function PlacedEffect({ t, at, fps, kit, apply }: { t: AudioTrack; at: number | null; fps: number; kit: KitEntry[] | null; apply: (ops: Operation[]) => Promise<boolean> }) {
  const hit = kit?.find((k) => k.assetId === t.assetId)?.hitSec ?? 0;
  const lands = at !== null ? at / fps + Math.max(0, hit - t.sourceInSec) : null;
  return (
    <li className="flex items-center gap-2" data-role={t.sfx!.role}>
      <span className="w-14 tabular-nums text-dim">{lands !== null ? `${lands.toFixed(2)} s` : "—"}</span>
      <span className="font-medium">{t.sfx!.role}</span>
      <span className="truncate text-faint">{t.sfx!.event}</span>
      <span className="ml-auto tabular-nums text-faint">{t.gainDb} dB</span>
      <button className="btn btn-ghost px-1.5 py-0 text-[11px]" aria-label={`Remove ${t.sfx!.role} at ${t.sfx!.event}`} onClick={() => void apply([{ op: "removeAudioTrack", trackId: t.id }])}>
        ✕
      </button>
    </li>
  );
}
