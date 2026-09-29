"use client";
import type { AudioTrack, Operation, ProjectDocument } from "@vs/domain";
import { AssetPicker } from "@/components/AssetPicker";
import { NumberField } from "./fields";
import { newClientId } from "./ids";

export function AudioPanel({ doc, apply }: { doc: ProjectDocument; apply: (ops: Operation[]) => Promise<boolean> }) {
  const music = doc.audio.filter((t) => t.kind === "music");
  return (
    <div className="space-y-4">
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
