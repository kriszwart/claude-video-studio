"use client";
import { DIRECTION_SUPPORT, NEUTRAL_DIRECTION, voiceKind, type ProjectDocument, type VoiceDirection } from "@vs/domain";
import { DebouncedText } from "./fields";

/** The voice this project narrates with: the recorded voiceover's, else the one chosen in the composer. */
export function projectVoiceId(doc: ProjectDocument): string | null {
  const recorded = doc.audio.find((t) => t.kind === "voiceover" && t.generatedFrom?.voiceId)?.generatedFrom?.voiceId;
  return recorded ?? doc.review?.next.voiceId ?? doc.script?.next.voiceId ?? null;
}

const PACES = [["slower", "Slower"], ["normal", "Normal"], ["faster", "Faster"]] as const;
const ENERGIES = [["calm", "Calm"], ["neutral", "Neutral"], ["lively", "Lively"]] as const;

/**
 * Per-line delivery: pace, energy and a short note. Parts the project's voice can't use are
 * dimmed with the reason, so nothing looks like it works when it won't.
 */
export function VoiceDirectionControls({ value, onChange, voiceId, label, disabled }: { value: VoiceDirection | undefined; onChange: (d: VoiceDirection | null) => void; voiceId: string | null; label: string; disabled?: boolean }) {
  const d = value ?? NEUTRAL_DIRECTION;
  const support = voiceId ? DIRECTION_SUPPORT[voiceKind(voiceId)] : null;
  const set = (patch: Partial<VoiceDirection>) => {
    const next = { ...d, ...patch };
    onChange(next.pace === "normal" && next.energy === "neutral" && !next.note.trim() ? null : next);
  };
  return (
    <fieldset className="space-y-1.5" aria-label={label} disabled={disabled}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Seg label={`${label}: pace`} options={PACES} value={d.pace} onChange={(v) => set({ pace: v })} />
        <Seg label={`${label}: energy`} options={ENERGIES} value={d.energy} onChange={(v) => set({ energy: v })} dim={support ? !support.energy : false} />
      </div>
      <div className={support && !support.note ? "opacity-60" : ""}>
        <DebouncedText ariaLabel={`${label}: delivery note`} value={d.note} maxLength={200} placeholder="Delivery note, e.g. stress “focus”; let the pause land" onCommit={(v) => set({ note: v })} />
      </div>
      {support && <p className="text-[10px] leading-snug text-faint">{support.how}</p>}
    </fieldset>
  );
}

function Seg<T extends string>({ label, options, value, onChange, dim }: { label: string; options: readonly (readonly [T, string])[]; value: T; onChange: (v: T) => void; dim?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className={`flex rounded-md border border-line bg-bg p-0.5 ${dim ? "opacity-60" : ""}`}>
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={`rounded px-2 py-0.5 text-[11px] ${value === v ? "bg-panel-2 font-medium text-ink" : "text-dim hover:text-ink"}`} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}
