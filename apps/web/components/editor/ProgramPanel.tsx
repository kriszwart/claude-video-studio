"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { computeTimeline, programFrames, type EditorialBeat, type Operation, type ProjectDocument } from "@vs/domain";
import { AssetPicker } from "@/components/AssetPicker";
import { api, ApiError } from "@/lib/client/api";
import { DebouncedText, NumberField } from "./fields";
import { newClientId } from "./ids";
import type { JobDTO, ProjectViewDTO } from "./types";

type Seg = { id: string; startSec: number; endSec: number; text: string; original: string; corrected: boolean; outputSec: number | null };
type Transcript = { transcriptId: string; provider: string; granularity: string; segments: Seg[] };
type Occ = { occurrence: number; startSec: number; context: string; outputSec: number | null; precision: string };
type Apply = (ops: Operation[]) => Promise<boolean>;

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const active = (jobs: JobDTO[], type: string) => jobs.find((j) => j.type === type && ["queued", "running"].includes(j.status));
const latest = (jobs: JobDTO[], type: string) => jobs.find((j) => j.type === type);

/** Talking-head workflow (FR-13/FR-14): transcript, reviewable cuts, beat sheet, style variants. */
export function ProgramPanel({ projectId, doc, view, apply, onChanged }: { projectId: string; doc: ProjectDocument; view: ProjectViewDTO; apply: Apply; onChanged: () => void }) {
  const p = doc.program!;
  const [tx, setTx] = useState<Transcript | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!p.transcriptId) return setTx(null);
    try {
      setTx(await api<Transcript>(`/api/projects/${projectId}/transcript`));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }, [projectId, p.transcriptId]);
  // Reload whenever the document changes (corrections, cuts, restores).
  useEffect(() => {
    void load();
  }, [load, view.revision.id]);

  return (
    <div className="space-y-5 text-sm">
      {err && <p className="text-xs text-bad">{err}</p>}
      <TranscriptSection projectId={projectId} doc={doc} jobs={view.jobs} tx={tx} apply={apply} onChanged={onChanged} />
      {p.transcriptId && <CutsSection projectId={projectId} doc={doc} jobs={view.jobs} apply={apply} onChanged={onChanged} tx={tx} />}
      {p.transcriptId && <BeatSheet projectId={projectId} doc={doc} view={view} apply={apply} />}
      {p.transcriptId && <Variants projectId={projectId} />}
    </div>
  );
}

function TranscriptSection({ projectId, doc, jobs, tx, apply, onChanged }: { projectId: string; doc: ProjectDocument; jobs: JobDTO[]; tx: Transcript | null; apply: Apply; onChanged: () => void }) {
  const [sub, setSub] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const running = active(jobs, "transcribe");
  const last = latest(jobs, "transcribe");
  const start = async (body: Record<string, unknown>) => {
    setMsg(null);
    try {
      await api(`/api/projects/${projectId}/transcribe`, { method: "POST", json: body });
      onChanged();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <section aria-labelledby="tx-h" className="space-y-2">
      <h3 id="tx-h" className="font-medium">Transcript</h3>
      {running && <p role="status" className="text-xs text-dim">Transcribing… {running.stage}</p>}
      {!running && last?.status === "failed" && (
        <p className="text-xs text-bad">
          {last.error?.message} {last.error?.recovery}
        </p>
      )}
      {!tx && !running && <p className="text-xs text-dim">No transcript yet. Import subtitles you already have, or use a connected speech-to-text provider.</p>}
      <div className="card space-y-2 p-2.5 text-xs">
        <label className="label">Import subtitles (SRT/VTT)</label>
        <AssetPicker kind="document" value={sub} onChange={setSub} />
        <div className="flex flex-wrap gap-2">
          <button className="btn text-xs" disabled={!sub[0] || !!running} onClick={() => start({ provider: "subtitle", subtitleAssetId: sub[0], force: true })}>
            Import transcript
          </button>
          <button className="btn btn-ghost text-xs" disabled={!!running} onClick={() => start({ provider: "auto", force: true })} title="ElevenLabs if configured, otherwise local whisper.cpp if configured">
            Transcribe with provider
          </button>
        </div>
        {msg && <p className="text-bad">{msg}</p>}
      </div>
      {tx && (
        <>
          <p className="text-xs text-dim">
            Source: {tx.provider} · {tx.granularity === "word" ? "word timings" : "segment timings (word positions estimated)"} · {tx.segments.length} segments. The original transcript is never overwritten; corrections are kept separately.
          </p>
          <ol className="max-h-72 space-y-1 overflow-y-auto pr-1" aria-label="Transcript segments">
            {tx.segments.map((s) => (
              <li key={s.id} className={`rounded border border-line p-1.5 text-xs ${s.outputSec === null ? "opacity-50" : ""}`}>
                <div className="mb-1 flex items-center gap-2 text-[11px] text-faint">
                  <span title="Source time">{fmt(s.startSec)}</span>→<span title="Output time">{s.outputSec === null ? "cut" : fmt(s.outputSec)}</span>
                  {s.corrected && <span className="chip" title={`Original: ${s.original}`}>corrected</span>}
                  {s.outputSec === null && (
                    <button className="ml-auto underline" onClick={() => apply([{ op: "restoreSourceRange", sourceInSec: Math.max(0, s.startSec - 0.05), sourceOutSec: s.endSec + 0.05 }])}>
                      Restore
                    </button>
                  )}
                </div>
                <DebouncedText ariaLabel={`Correct segment at ${fmt(s.startSec)}`} value={s.text} maxLength={2000} onCommit={(v) => v.trim() && apply([{ op: "correctTranscript", segmentId: s.id, text: v }])} />
              </li>
            ))}
          </ol>
        </>
      )}
      <p className="text-[11px] text-faint">Background removal: unavailable — no segmentation provider is connected. The original background is always kept.</p>
      {doc.program?.edl && <p className="text-[11px] text-faint">Output {(programFrames(doc) / 30).toFixed(1)} s from {doc.program.edl.length} kept range(s).</p>}
    </section>
  );
}

function CutsSection({ projectId, doc, jobs, apply, onChanged, tx }: { projectId: string; doc: ProjectDocument; jobs: JobDTO[]; apply: Apply; onChanged: () => void; tx: Transcript | null }) {
  const p = doc.program!;
  const running = active(jobs, "propose_cuts");
  const last = latest(jobs, "propose_cuts");
  const [msg, setMsg] = useState<string | null>(null);
  const propose = async () => {
    setMsg(null);
    try {
      await api(`/api/projects/${projectId}/cuts`, { method: "POST", json: {} });
      onChanged();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    }
  };
  const byKind = (k: string) => p.proposedCuts.filter((c) => c.kind === k);
  const removed = tx ? tx.segments.filter((s) => s.outputSec === null).length : 0;
  return (
    <section aria-labelledby="cuts-h" className="space-y-2">
      <h3 id="cuts-h" className="font-medium">Cuts</h3>
      <p className="text-xs text-dim">Your speech is preserved unless you accept a cut. Pauses need both silent audio and no transcript speech; retakes show context so you can choose the take.</p>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn text-xs" disabled={!!running} onClick={propose}>
          {running ? `Analysing… ${running.stage}` : "Find pauses, fillers & retakes"}
        </button>
        {last?.status === "failed" && <span className="text-xs text-bad">{last.error?.message}</span>}
        {msg && <span className="text-xs text-bad">{msg}</span>}
      </div>
      <fieldset className="card space-y-1 p-2 text-xs">
        <legend className="px-1 text-faint">Cleanup policy (applies to future proposals)</legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={p.cleanupPolicy.autoAcceptSilence} onChange={(e) => apply([{ op: "setCleanupPolicy", autoAcceptSilence: e.target.checked, autoAcceptFillers: p.cleanupPolicy.autoAcceptFillers }])} />
          Remove long pauses automatically
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={p.cleanupPolicy.autoAcceptFillers} onChange={(e) => apply([{ op: "setCleanupPolicy", autoAcceptSilence: p.cleanupPolicy.autoAcceptSilence, autoAcceptFillers: e.target.checked }])} />
          Remove filler-only words automatically
        </label>
        <p className="text-faint">Retakes and anything that changes meaning always stay in review.</p>
      </fieldset>
      {p.proposedCuts.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2 text-xs">
            {byKind("silence").length > 0 && (
              <button className="btn text-xs" onClick={() => apply([{ op: "acceptCuts", cutIds: byKind("silence").map((c) => c.id) }])}>
                Accept {byKind("silence").length} pause(s)
              </button>
            )}
            <button className="btn btn-ghost text-xs" onClick={() => apply([{ op: "rejectCuts", cutIds: p.proposedCuts.map((c) => c.id) }])}>
              Dismiss all
            </button>
          </div>
          <ul className="space-y-1.5" aria-label="Proposed cuts">
            {p.proposedCuts.map((c) => (
              <li key={c.id} className="card space-y-1 p-2 text-xs" data-testid={`cut-${c.kind}`}>
                <div className="flex items-center gap-2">
                  <span className={`chip ${c.kind === "mistake" ? "text-warn" : ""}`}>{c.kind === "mistake" ? "retake" : c.kind}</span>
                  <span className="text-faint">
                    {fmt(c.sourceInSec)}–{fmt(c.sourceOutSec)} ({(c.sourceOutSec - c.sourceInSec).toFixed(1)} s)
                  </span>
                  <button className="btn ml-auto px-2 py-0.5 text-[11px]" onClick={() => apply([{ op: "acceptCuts", cutIds: [c.id] }])}>
                    Cut
                  </button>
                  <button className="btn btn-ghost px-2 py-0.5 text-[11px]" onClick={() => apply([{ op: "rejectCuts", cutIds: [c.id] }])}>
                    Keep
                  </button>
                </div>
                <p>{c.reason}</p>
                {c.context && <p className="text-faint">{c.context}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {removed > 0 && <p className="text-[11px] text-faint">{removed} transcript segment(s) currently cut — use Restore in the transcript to bring one back.</p>}
    </section>
  );
}

function BeatSheet({ projectId, doc, view, apply }: { projectId: string; doc: ProjectDocument; view: ProjectViewDTO; apply: Apply }) {
  const [phrase, setPhrase] = useState("");
  const [occ, setOcc] = useState<Occ[] | null>(null);
  const [pick, setPick] = useState(1);
  const find = async () => {
    const r = await api<{ occurrences: Occ[] }>(`/api/projects/${projectId}/transcript?phrase=${encodeURIComponent(phrase)}`);
    setOcc(r.occurrences);
    setPick(1);
  };
  const add = () => {
    const beat: EditorialBeat = {
      id: newClientId("beat"),
      cue: { phrase: phrase.trim(), occurrence: pick },
      message: "",
      visualAction: "label",
      text: phrase.trim(),
      anchor: null,
      anchorLocked: false,
      durationFrames: 75,
      emphasis: "medium",
      backing: "translucent",
      mode: "strict",
      locked: false,
      origin: "user",
      status: "unmapped",
    };
    void apply([{ op: "setBeats", beats: [...doc.beats, beat] }]);
    setPhrase("");
    setOcc(null);
  };
  return (
    <section aria-labelledby="beats-h" className="space-y-2">
      <h3 id="beats-h" className="font-medium">Beat sheet</h3>
      <p className="text-xs text-dim">Editorial beats are timed to what you say, not to music. Repeated phrases resolve to the occurrence you choose; after cuts or corrections they follow the utterance or are flagged.</p>
      <fieldset className="card flex flex-wrap items-center gap-3 p-2 text-xs">
        <legend className="px-1 text-faint">Assistant creative mode</legend>
        {(["strict", "flexible"] as const).map((m) => (
          <label key={m} className="flex items-center gap-1.5">
            <input type="radio" name="creative-mode" checked={doc.program!.creativeMode === m} onChange={() => apply([{ op: "setCreativeMode", mode: m }])} />
            {m === "strict" ? "Strict — only my beats" : `Flexible — up to ${doc.program!.flexibleBeatLimit} supporting beats`}
          </label>
        ))}
        <span className="text-faint">Neither mode changes approved claims or locked beats, and flexible additions use only media already in this project.</span>
      </fieldset>
      <div className="card space-y-2 p-2 text-xs">
        <label className="label" htmlFor="beat-phrase">Cue phrase</label>
        <div className="flex gap-2">
          <input id="beat-phrase" className="input" value={phrase} maxLength={200} onChange={(e) => setPhrase(e.target.value)} placeholder="e.g. Tool A" />
          <button className="btn text-xs" disabled={!phrase.trim()} onClick={find}>
            Find
          </button>
        </div>
        {occ && occ.length === 0 && <p className="text-warn">“{phrase}” is not in the transcript. Nothing will be guessed; check the wording or correct the transcript.</p>}
        {occ && occ.length > 0 && (
          <div className="space-y-1">
            {occ.map((o) => (
              <label key={o.occurrence} className="flex items-start gap-2">
                <input type="radio" name="occ" checked={pick === o.occurrence} onChange={() => setPick(o.occurrence)} />
                <span>
                  #{o.occurrence} at {fmt(o.startSec)} {o.outputSec === null ? "(cut)" : `→ ${fmt(o.outputSec)}`} <span className="text-faint">…{o.context}…</span>
                </span>
              </label>
            ))}
            <button className="btn text-xs" onClick={add}>
              Add beat
            </button>
          </div>
        )}
      </div>
      <ul className="space-y-2" aria-label="Beats">
        {doc.beats.map((b) => (
          <BeatRow key={b.id} b={b} doc={doc} view={view} apply={apply} />
        ))}
      </ul>
    </section>
  );
}

function BeatRow({ b, doc, view, apply }: { b: EditorialBeat; doc: ProjectDocument; view: ProjectViewDTO; apply: Apply }) {
  const patch = (p: Partial<EditorialBeat>) => apply([{ op: "updateBeat", beatId: b.id, patch: p }]);
  const status = b.status === "mapped" ? "text-ok" : "text-warn";
  return (
    <li className="card space-y-2 p-2 text-xs" data-testid={`beat-${b.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">“{b.cue.phrase}”</span>
        {b.origin === "assistant-flexible" && <span className="chip">assistant</span>}
        <span className="text-faint">#{b.cue.occurrence}</span>
        <span className={status}>{b.status}</span>
        {b.outputFrame !== undefined && b.status === "mapped" && <span className="text-faint">at {fmt(b.outputFrame / 30)}</span>}
        <label className="ml-auto flex items-center gap-1">
          <input type="checkbox" checked={b.locked} onChange={(e) => patch({ locked: e.target.checked })} /> lock
        </label>
        <button className="btn btn-ghost px-2 py-0.5 text-[11px] text-bad" onClick={() => apply([{ op: "setBeats", beats: doc.beats.filter((x) => x.id !== b.id) }])}>
          Remove
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Visual</label>
          <select className="input" value={b.visualAction} onChange={(e) => patch({ visualAction: e.target.value as EditorialBeat["visualAction"] })}>
            {["label", "logo", "image", "b-roll", "emphasis"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Mode</label>
          <select className="input" value={b.mode} onChange={(e) => patch({ mode: e.target.value as EditorialBeat["mode"] })}>
            <option value="strict">strict</option>
            <option value="flexible">flexible</option>
          </select>
        </div>
        <div className="col-span-2">
          <label className="label">Text</label>
          <DebouncedText value={b.text} maxLength={200} onCommit={(v) => patch({ text: v })} />
        </div>
        <div>
          <label className="label">Duration</label>
          <NumberField value={b.durationFrames / 30} min={0.3} max={20} step={0.1} suffix="s" onCommit={(v) => patch({ durationFrames: Math.max(1, Math.round(v * 30)) })} />
        </div>
        <div>
          <label className="label">Backing</label>
          <select className="input" value={b.backing} onChange={(e) => patch({ backing: e.target.value as EditorialBeat["backing"] })}>
            <option value="translucent">translucent</option>
            <option value="solid">solid (bright footage)</option>
          </select>
        </div>
      </div>
      {(b.visualAction === "logo" || b.visualAction === "image" || b.visualAction === "b-roll") && (
        <div>
          <label className="label">Approved asset</label>
          <AssetPicker kind={b.visualAction === "b-roll" ? "video" : "image"} value={b.assetId ? [b.assetId] : []} onChange={(ids) => patch({ assetId: ids[0] })} />
          {b.visualAction === "b-roll" && <p className="mt-1 text-[11px] text-faint">B-roll plays muted in a card, so your speech is never replaced.</p>}
        </div>
      )}
      <AnchorPad b={b} doc={doc} view={view} apply={apply} />
    </li>
  );
}

/** Drag the beat's anchor over the frame at its cue; placing it locks the position (FR-14). */
function AnchorPad({ b, doc, view, apply }: { b: EditorialBeat; doc: ProjectDocument; view: ProjectViewDTO; apply: Apply }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const tl = computeTimeline(doc);
  const scene = b.outputFrame !== undefined ? tl.scenes.find((s) => b.outputFrame! >= s.start && b.outputFrame! < s.end) : undefined;
  const still = scene ? view.keyframes[scene.sceneId]?.url : undefined;
  const [w, h] = doc.format.aspect === "9:16" ? [9, 16] : doc.format.aspect === "1:1" ? [1, 1] : [16, 9];
  const pos = drag ?? b.anchor;
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="label mb-0">Position</span>
        <span className="text-faint">{b.anchor ? `${Math.round(b.anchor.x * 100)}%, ${Math.round(b.anchor.y * 100)}%${b.anchorLocked ? " · locked" : ""}` : "automatic"}</span>
        {b.anchor && (
          <button className="ml-auto underline" onClick={() => apply([{ op: "setBeatAnchor", beatId: b.id, anchor: null, lock: false }])}>
            Reset
          </button>
        )}
      </div>
      <div
        ref={ref}
        role="application"
        aria-label={`Drag to place “${b.cue.phrase}”`}
        className="relative w-full cursor-crosshair touch-none select-none overflow-hidden rounded border border-line bg-panel-2"
        style={{ aspectRatio: `${w} / ${h}`, backgroundImage: still ? `url(${still})` : undefined, backgroundSize: "cover" }}
        onPointerDown={(e) => {
          ref.current!.setPointerCapture(e.pointerId);
          setDrag(at(e));
        }}
        onPointerMove={(e) => drag && setDrag(at(e))}
        onPointerUp={(e) => {
          const p = at(e);
          setDrag(null);
          void apply([{ op: "setBeatAnchor", beatId: b.id, anchor: { x: Number(p.x.toFixed(3)), y: Number(p.y.toFixed(3)) }, lock: true }]);
        }}
      >
        {!still && <span className="absolute inset-0 grid place-items-center text-[11px] text-faint">Refresh keyframes to see the frame</span>}
        {pos && <span className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-accent shadow" style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%` }} />}
      </div>
      <p className="text-[11px] text-faint">Transcript timing can't tell where you point; place the label yourself and it stays locked.</p>
    </div>
  );
}

function Variants({ projectId }: { projectId: string }) {
  const [list, setList] = useState<{ id: string; title: string; label: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => api<{ variants: { id: string; title: string; label: string }[] }>(`/api/projects/${projectId}/variants`).then((r) => setList(r.variants)), [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  const make = async (style: string) => {
    setBusy(style);
    setMsg(null);
    try {
      const r = await api<{ project: { id: string; title: string } }>(`/api/projects/${projectId}/variants`, { method: "POST", json: { style } });
      setMsg(`Created “${r.project.title}”.`);
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-labelledby="var-h" className="space-y-2">
      <h3 id="var-h" className="font-medium">Style variants</h3>
      <p className="text-xs text-dim">Each variant is its own project that reuses this recording, transcript, corrections and cuts — nothing is re-uploaded or re-transcribed, and editing one never changes another.</p>
      <div className="flex flex-wrap gap-2">
        {[
          ["whiteboard", "Whiteboard"],
          ["course", "Course lesson"],
          ["social", "Fast Social (9:16)"],
          ["presenter-intro", "Presenter intro"],
        ].map(([k, label]) => (
          <button key={k} className="btn text-xs" disabled={!!busy} onClick={() => make(k!)}>
            {busy === k ? "Creating…" : `+ ${label}`}
          </button>
        ))}
      </div>
      {msg && <p role="status" className="text-xs text-dim">{msg}</p>}
      {list.length > 1 && (
        <ul className="space-y-1 text-xs">
          {list.map((v) => (
            <li key={v.id}>
              {v.id === projectId ? (
                <span className="font-medium">{v.label} (this project)</span>
              ) : (
                <Link className="underline" href={`/projects/${v.id}`}>
                  {v.label}: {v.title}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
