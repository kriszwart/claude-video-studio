"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { claudeRequestRange, EFFORT_LEVELS, EFFORT_ORDER, SCRIPT_STYLE_IDS, SCRIPT_STYLES, type EffortLevel, type ScriptStyle } from "@vs/domain";
import { AssetPicker } from "@/components/AssetPicker";
import { TemplatePoster, type Poster } from "@/components/TemplatePoster";
import { api, ApiError, waitForJob, type UploadedAsset } from "@/lib/client/api";
import type { ClaudeStatus } from "@/lib/client/claude";

export interface ComposerTemplate {
  id: string;
  name: string;
  description: string;
  family: string;
  preset: string | null;
  version: number;
  supportedAspects: string[];
  duration: { minSec: number; maxSec: number; defaultSec: number };
  availability: { ready: boolean; workerOnline: boolean; missingRequired: string[] };
  poster: Poster | null;
}
interface Voice {
  id: string;
  label: string;
  language: string;
  kind: string;
}
interface BrandKit {
  id: string;
  name: string;
}
type Aspect = "16:9" | "9:16" | "1:1";
interface Settings {
  aspect: Aspect | null;
  durationSec: number | null;
  music: "auto" | "on" | "off";
  /** "auto", "off", or a specific voice id. */
  voice: string;
  brandKitId: string | null;
  scriptStyle: ScriptStyle | null;
}
interface Proposal {
  templateId: string;
  templateVersion: number;
  templateName: string;
  title: string;
  aspect: Aspect;
  durationSec: number;
  narration: boolean;
  scriptStyle: ScriptStyle;
  inputs: Record<string, string | number | string[]>;
  facts: { inputId: string; label: string; items: string[] }[];
  rationale: string;
  warnings: string[];
}

const AUTO: Settings = { aspect: null, durationSec: null, music: "auto", voice: "auto", brandKitId: null, scriptStyle: null };

/** Seconds ↔ slider position on a log scale, 5 s … 10 min. */
const MIN_S = 5;
const MAX_S = 600;
const toPos = (s: number) => Math.log(s / MIN_S) / Math.log(MAX_S / MIN_S);
const fromPos = (p: number) => {
  const s = MIN_S * Math.pow(MAX_S / MIN_S, p);
  return s < 60 ? Math.round(s) : Math.round(s / 5) * 5;
};
export function fmtLength(s: number) {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return r ? `${m} min ${r} s` : `${m} min`;
}

/** Free voices first; a paid voice (ElevenLabs) is used only when picked explicitly. */
function autoVoice(voices: Voice[]): Voice | null {
  return voices.find((v) => v.kind === "omnivoice") ?? voices.find((v) => v.kind === "local") ?? null;
}

/**
 * The prompt-first composer: describe the video, optionally pin a template, settings and effort,
 * and attach material. Claude proposes the project; the owner reviews it and creates it.
 */
export function Composer({ templates, claude, onOpenForm }: { templates: ComposerTemplate[]; claude: ClaudeStatus | null; onOpenForm: (templateId: string) => void }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(AUTO);
  const [effort, setEffort] = useState<EffortLevel>("standard");
  const [attached, setAttached] = useState<{ image: string[]; video: string[]; audio: string[] }>({ image: [], video: [], audio: [] });
  const [attachMeta, setAttachMeta] = useState<Record<string, UploadedAsset>>({});
  const [panel, setPanel] = useState<"settings" | "effort" | "attach" | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [brandKits, setBrandKits] = useState<BrandKit[]>([]);
  const [phase, setPhase] = useState<"idle" | "composing" | "review" | "creating">("idle");
  const [stage, setStage] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const suggestion = useJevSuggestion(prompt, templateId, templates, attached, phase === "idle");

  useEffect(() => {
    api<{ voices: Voice[] }>("/api/voices").then((r) => setVoices(r.voices)).catch(() => {});
    api<{ brandKits: BrandKit[] }>("/api/brand-kits").then((r) => setBrandKits(r.brandKits)).catch(() => {});
  }, []);
  // Resolve names/thumbnails of attached assets for the chips.
  const attachedIds = useMemo(() => [...attached.image, ...attached.video, ...attached.audio], [attached]);
  useEffect(() => {
    const missing = attachedIds.filter((id) => !attachMeta[id]);
    if (!missing.length) return;
    void Promise.all(missing.map((id) => api<{ asset: UploadedAsset }>(`/api/assets/${id}`).then((r) => r.asset).catch(() => null))).then((list) =>
      setAttachMeta((m) => ({ ...m, ...Object.fromEntries(list.filter(Boolean).map((a) => [a!.id, a!])) })),
    );
  }, [attachedIds, attachMeta]);

  const tpl = templates.find((t) => t.id === templateId) ?? null;
  const usable = templates.filter((t) => t.availability.ready);
  const claudeReady = !!claude?.readiness.available;
  const subscription = claude?.readiness.mode !== "api";
  const [lo, hi] = claudeRequestRange(effort);
  const defaultVoice = autoVoice(voices);
  const pickedVoice = settings.voice !== "auto" && settings.voice !== "off" ? voices.find((v) => v.id === settings.voice) : null;
  const paidVoice = pickedVoice?.kind === "elevenlabs";
  const brandAuto = brandKits.length === 1 ? brandKits[0]! : null;

  const settingsLabel = [settings.aspect ?? "Auto", settings.durationSec ? fmtLength(settings.durationSec) : "Auto length"].join(" · ");

  const compose = async () => {
    if (!claudeReady || prompt.trim().length < 3) return;
    setErr(null);
    setPanel(null);
    setPhase("composing");
    setStage("Sending to Claude…");
    try {
      const { job } = await api<{ job: { id: string } }>("/api/compose", {
        method: "POST",
        idempotent: true,
        json: {
          prompt: prompt.trim(),
          templateId,
          settings: { aspect: settings.aspect, durationSec: settings.durationSec, music: settings.music, voice: settings.voice === "auto" ? "auto" : settings.voice === "off" || (!pickedVoice && !defaultVoice) ? "off" : "on", scriptStyle: settings.scriptStyle },
          effort,
          assetIds: attachedIds,
        },
      });
      const done = await waitForJob(job.id, (j) => j.stage && setStage(j.stage === "queued" ? "Waiting for the worker…" : `Claude is ${j.stage}…`));
      if (done.status === "paused") throw new Error(`${done.error?.message ?? "Claude paused at a usage limit."} Nothing was created; send again after the limit resets.`);
      if (done.status !== "succeeded") throw new Error(`${done.error?.message ?? "Claude could not compose this request."}${done.error?.recovery ? ` ${done.error.recovery}` : ""}`);
      setProposal(done.result as unknown as Proposal);
      setPhase("review");
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.message}${e.recovery ? ` — ${e.recovery}` : ""}` : e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  const create = async () => {
    if (!proposal) return;
    setErr(null);
    setPhase("creating");
    const voice = proposal.narration ? (pickedVoice ?? (settings.voice === "auto" ? defaultVoice : null)) : null;
    const plan = EFFORT_LEVELS[effort].plan;
    const inputs = { ...proposal.inputs };
    for (const f of proposal.facts) {
      const items = f.items.map((s) => s.trim()).filter(Boolean);
      if (items.length) inputs[f.inputId] = items;
      else delete inputs[f.inputId];
    }
    try {
      const r = await api<{ project: { id: string } }>("/api/projects", {
        method: "POST",
        idempotent: true,
        json: {
          templateId: proposal.templateId,
          templateVersion: proposal.templateVersion,
          title: proposal.title,
          aspect: proposal.aspect,
          durationSec: proposal.durationSec,
          inputs,
          brandKitId: settings.brandKitId ?? brandAuto?.id ?? undefined,
          plan: !!plan,
          ...(plan ? { planEffort: plan, script: { style: proposal.scriptStyle, narrated: proposal.narration } } : {}),
          ...(voice ? { narration: { voiceId: voice.id } } : {}),
        },
      });
      router.push(`/projects/${r.project.id}`);
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.message}${e.recovery ? ` — ${e.recovery}` : ""}` : String(e));
      setPhase("review");
    }
  };

  if (phase === "review" || phase === "creating") {
    return <Review proposal={proposal!} setProposal={setProposal} templates={templates} effort={effort} voice={proposal!.narration ? (pickedVoice ?? (settings.voice === "auto" ? defaultVoice : null)) : null} busy={phase === "creating"} err={err} onBack={() => setPhase("idle")} onCreate={create} />;
  }

  return (
    <section aria-label="Composer" className="mx-auto max-w-3xl">
      <h1 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">What are we making?</h1>
      <p className="mt-2 text-center text-sm text-dim">Describe the video in a sentence or two. Anything left on Auto is up to Claude — you review the plan before anything is built.</p>

      <div className="card mt-6 overflow-visible p-0 focus-within:border-accent/60">
        {(tpl || attachedIds.length > 0) && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {tpl && (
              <span className="chip flex items-center gap-1.5 border-accent/50 bg-accent/10 py-1 text-ink">
                <span className="text-accent">▣</span> {tpl.name}
                <button aria-label={`Remove template ${tpl.name}`} className="text-faint hover:text-ink" onClick={() => setTemplateId(null)}>×</button>
              </span>
            )}
            {attachedIds.map((id) => {
              const a = attachMeta[id];
              return (
                <span key={id} className="chip flex max-w-56 items-center gap-1.5 py-1">
                  {a?.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.thumbUrl} alt="" className="h-4 w-6 rounded-sm object-cover" />
                  ) : (
                    <span className="text-faint">{a?.kind === "audio" ? "♪" : "▶"}</span>
                  )}
                  <span className="truncate">{a?.name ?? "attachment"}</span>
                  <button aria-label={`Remove ${a?.name ?? "attachment"}`} className="text-faint hover:text-ink" onClick={() => setAttached((x) => ({ image: x.image.filter((i) => i !== id), video: x.video.filter((i) => i !== id), audio: x.audio.filter((i) => i !== id) }))}>×</button>
                </span>
              );
            })}
          </div>
        )}
        <textarea
          ref={box}
          aria-label="Describe the video"
          className="block min-h-28 w-full resize-y bg-transparent px-4 py-3 text-[15px] leading-relaxed text-ink outline-none placeholder:text-faint"
          placeholder={tpl ? `What should this ${tpl.name.toLowerCase()} say? e.g. who it is for, the one message, the call to action.` : "e.g. A 30-second launch video for Tidewave, a calendar app that blocks focus time. Calm, confident, ends with “Try it free”."}
          value={prompt}
          maxLength={4000}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void compose();
          }}
          disabled={phase === "composing"}
        />
        {suggestion && (
          <Suggestions
            s={suggestion}
            templates={templates}
            templateId={templateId}
            settings={settings}
            onTemplate={setTemplateId}
            onSettings={(patch) => setSettings((cur) => ({ ...cur, ...patch }))}
          />
        )}
        <div className="relative flex flex-wrap items-center gap-1.5 border-t border-line px-2 py-2">
          <button className={`btn btn-ghost h-8 px-2.5 text-xs ${panel === "attach" ? "bg-panel-2" : ""}`} aria-expanded={panel === "attach"} onClick={() => setPanel(panel === "attach" ? null : "attach")} title="Attach images, footage or music">
            + Attach
          </button>
          <button className={`btn btn-ghost h-8 px-2.5 text-xs ${panel === "settings" ? "bg-panel-2" : ""}`} aria-expanded={panel === "settings"} onClick={() => setPanel(panel === "settings" ? null : "settings")}>
            {settingsLabel} ▾
          </button>
          <button className={`btn btn-ghost h-8 px-2.5 text-xs ${panel === "effort" ? "bg-panel-2" : ""}`} aria-expanded={panel === "effort"} onClick={() => setPanel(panel === "effort" ? null : "effort")}>
            Effort: {EFFORT_LEVELS[effort].label} ▾
          </button>
          <span className="ml-auto hidden text-[11px] text-faint sm:inline" data-testid="estimate">
            {subscription ? `Uses your Claude plan · about ${lo}–${hi} requests` : `Claude API key · about ${lo}–${hi} requests, billed per token`}
            {paidVoice ? " · ElevenLabs bills per character" : ""}
          </span>
          <button className="btn btn-primary h-8 px-4" disabled={!claudeReady || prompt.trim().length < 3 || phase === "composing"} onClick={() => void compose()} title="Send (⌘/Ctrl + Enter)">
            {phase === "composing" ? "Composing…" : "Compose ↑"}
          </button>

          {panel === "settings" && (
            <Popover onClose={() => setPanel(null)} label="Video settings">
              <Field label="Aspect ratio">
                <Seg options={[["auto", "Auto"], ["16:9", "16:9"], ["9:16", "9:16"], ["1:1", "1:1"]]} value={settings.aspect ?? "auto"} onChange={(v) => setSettings({ ...settings, aspect: v === "auto" ? null : (v as Aspect) })} />
              </Field>
              <Field
                label="Length"
                right={
                  <span className="text-xs">
                    {settings.durationSec ? (
                      <>
                        <button className="mr-2 text-faint underline" onClick={() => setSettings({ ...settings, durationSec: null })}>Use Auto</button>
                        About {fmtLength(settings.durationSec)}
                      </>
                    ) : (
                      <span className="text-dim">Auto</span>
                    )}
                  </span>
                }
              >
                <input type="range" aria-label="Length" className="scrub w-full" min={0} max={1} step={0.005} value={toPos(settings.durationSec ?? 30)} onChange={(e) => setSettings({ ...settings, durationSec: fromPos(Number(e.target.value)) })} />
                <div className="mt-1 flex justify-between text-[10px] text-faint"><span>5 s</span><span>1 min</span><span>3 min</span><span>10 min</span></div>
                {tpl && settings.durationSec && (settings.durationSec < tpl.duration.minSec || settings.durationSec > tpl.duration.maxSec) && (
                  <p className="mt-1 text-[11px] text-warn">{tpl.name} runs {fmtLength(tpl.duration.minSec)}–{fmtLength(tpl.duration.maxSec)}.</p>
                )}
              </Field>
              <Field label="Music">
                <Seg options={[["auto", "Auto"], ["on", "On"], ["off", "Off"]]} value={settings.music} onChange={(v) => setSettings({ ...settings, music: v as Settings["music"] })} />
                {settings.music === "on" && attached.audio.length === 0 && <p className="mt-1 text-[11px] text-warn">Attach a music track with + Attach; the studio does not generate music yet.</p>}
              </Field>
              <Field label="Voiceover">
                <select aria-label="Voiceover" className="input h-9" value={settings.voice} onChange={(e) => setSettings({ ...settings, voice: e.target.value })}>
                  <option value="auto">Auto{defaultVoice ? ` — ${defaultVoice.label}` : " — no free voice available"}</option>
                  <option value="off">Off</option>
                  {["omnivoice", "local", "elevenlabs"].map((k) => {
                    const list = voices.filter((v) => v.kind === k);
                    return list.length ? (
                      <optgroup key={k} label={k === "omnivoice" ? "OmniVoice (this computer)" : k === "local" ? "Built-in voices" : "ElevenLabs (paid)"}>
                        {list.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                      </optgroup>
                    ) : null;
                  })}
                </select>
              </Field>
              <Field label="Writing style">
                <select aria-label="Writing style" className="input h-9" value={settings.scriptStyle ?? ""} onChange={(e) => setSettings({ ...settings, scriptStyle: (e.target.value || null) as ScriptStyle | null })}>
                  <option value="">Auto — Claude picks for the request</option>
                  {SCRIPT_STYLE_IDS.map((id) => <option key={id} value={id}>{SCRIPT_STYLES[id].label}</option>)}
                </select>
                {settings.scriptStyle && <p className="mt-1 text-[11px] text-faint">{SCRIPT_STYLES[settings.scriptStyle].guide}</p>}
              </Field>
              <Field label="Brand">
                <select aria-label="Brand kit" className="input h-9" value={settings.brandKitId ?? ""} onChange={(e) => setSettings({ ...settings, brandKitId: e.target.value || null })}>
                  <option value="">{brandAuto ? `Auto — ${brandAuto.name}` : "Auto — studio default look"}</option>
                  {brandKits.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                </select>
              </Field>
              <p className="border-t border-line pt-2 text-[11px] text-faint">Anything left on Auto is up to Claude.</p>
            </Popover>
          )}
          {panel === "effort" && (
            <Popover onClose={() => setPanel(null)} label="Effort">
              <div className="rounded-md border border-line bg-bg px-3 py-4 text-center">
                <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-faint">Effort</div>
                <div className="text-2xl font-semibold tracking-tight text-accent">{EFFORT_LEVELS[effort].label}</div>
              </div>
              <Seg options={EFFORT_ORDER.map((e) => [e, EFFORT_LEVELS[e].label])} value={effort} onChange={(v) => setEffort(v as EffortLevel)} />
              <p className="text-xs text-dim">{EFFORT_LEVELS[effort].note}</p>
              <p className="text-[11px] text-faint">
                {subscription ? "Runs on your Claude plan through Claude Code — no API charges; higher effort uses more of your plan's usage window." : "Runs on your Claude API key, billed per token."} About {lo}–{hi} Claude requests (including automatic fixes).
              </p>
            </Popover>
          )}
          {panel === "attach" && (
            <Popover onClose={() => setPanel(null)} label="Attach" wide>
              <p className="text-xs text-dim">Material Claude may use: product shots, logos, screenshots, footage, a music track. Nothing is invented in its place.</p>
              <Field label="Images"><AssetPicker kind="image" multiple max={12} value={attached.image} onChange={(v) => setAttached({ ...attached, image: v })} /></Field>
              <Field label="Video"><AssetPicker kind="video" multiple max={6} value={attached.video} onChange={(v) => setAttached({ ...attached, video: v })} /></Field>
              <Field label="Music or recording"><AssetPicker kind="audio" multiple max={2} value={attached.audio} onChange={(v) => setAttached({ ...attached, audio: v })} /></Field>
            </Popover>
          )}
        </div>
      </div>

      {phase === "composing" && (
        <p className="mt-3 flex items-center justify-center gap-2 text-sm text-dim" role="status" aria-live="polite">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" /> {stage}
        </p>
      )}
      {!claudeReady && claude && (
        <p className="mt-3 text-center text-sm text-warn" role="status">
          {claude.readiness.message}{" "}
          <Link className="underline" href="/settings#claude">Set up Claude</Link> — or start from a template form below; manual editing and rendering work without Claude.
        </p>
      )}
      {err && <p role="alert" className="mt-3 text-center text-sm text-bad">{err}</p>}

      <div className="mt-10">
        <div className="mb-3 flex items-baseline gap-2">
          <h2 className="font-semibold">Templates</h2>
          <span className="text-xs text-faint">Pick one to steer Claude, or open its form to fill everything in yourself.</span>
        </div>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {templates.map((t) => (
            <li key={t.id} className={`card group overflow-hidden transition-colors ${templateId === t.id ? "border-accent" : "hover:border-accent/50"} ${t.availability.ready ? "" : "opacity-60"}`}>
              <button className="block w-full text-left" disabled={!t.availability.ready} onClick={() => { setTemplateId(templateId === t.id ? null : t.id); box.current?.focus(); }} aria-pressed={templateId === t.id} title={t.description}>
                <TemplatePoster poster={t.poster} family={t.family} name={t.name} />
                <div className="px-2.5 pb-1 pt-2 text-[13px] font-medium">{t.name}</div>
              </button>
              <div className="flex items-center px-2.5 pb-2 text-[11px] text-faint">
                {t.availability.ready ? `${t.duration.defaultSec}s · ${t.supportedAspects.join(" ")}` : t.availability.workerOnline ? `Needs ${t.availability.missingRequired.join(", ")}` : "No worker online"}
                <button className="ml-auto underline decoration-line hover:text-ink" onClick={() => onOpenForm(t.id)} disabled={!t.availability.ready}>Form</button>
              </div>
            </li>
          ))}
        </ul>
        {usable.length === 0 && <p className="mt-2 text-xs text-warn">No template is available: start the render worker.</p>}
      </div>
    </section>
  );
}

function Review({ proposal, setProposal, templates, effort, voice, busy, err, onBack, onCreate }: { proposal: Proposal; setProposal: (p: Proposal) => void; templates: ComposerTemplate[]; effort: EffortLevel; voice: Voice | null; busy: boolean; err: string | null; onBack: () => void; onCreate: () => void }) {
  const t = templates.find((x) => x.id === proposal.templateId);
  const plan = EFFORT_LEVELS[effort].plan;
  const textInputs = Object.entries(proposal.inputs).filter(([k, v]) => k !== "durationSec" && !proposal.facts.some((f) => f.inputId === k) && !(typeof v === "string" && v.startsWith("ast_")) && !(Array.isArray(v) && v.every((x) => x.startsWith("ast_"))));
  const mediaCount = Object.values(proposal.inputs).flat().filter((v) => typeof v === "string" && v.startsWith("ast_")).length;
  return (
    <section aria-label="Review Claude's proposal" className="mx-auto max-w-3xl">
      <button className="btn btn-ghost mb-3 px-2 text-xs" onClick={onBack} disabled={busy}>← Change the request</button>
      <div className="card overflow-hidden">
        <div className="grid gap-0 sm:grid-cols-[240px_1fr]">
          {t && <TemplatePoster poster={t.poster} family={t.family} name={t.name} />}
          <div className="space-y-3 p-4">
            <div>
              <div className="panel-title">Claude suggests</div>
              <div className="mt-1 text-lg font-semibold">{proposal.templateName}</div>
              <p className="mt-1 text-sm text-dim">{proposal.rationale}</p>
            </div>
            <div className="flex flex-wrap gap-1">
              <span className="chip">{proposal.aspect}</span>
              <span className="chip">{fmtLength(proposal.durationSec)}</span>
              <span className="chip">{proposal.narration ? (voice ? `Voice: ${voice.label}` : "Voiceover script only — no voice available") : "No voiceover"}</span>
              <span className="chip">{mediaCount ? `${mediaCount} attachment${mediaCount > 1 ? "s" : ""} used` : "No attachments used"}</span>
              <span className="chip">{plan ? `Script first (${SCRIPT_STYLES[proposal.scriptStyle]?.label ?? proposal.scriptStyle}), then storyboard` : "Template structure as is (Quick)"}</span>
            </div>
          </div>
        </div>
        <div className="space-y-4 border-t border-line p-4">
          <div>
            <label className="label" htmlFor="c-title">Title</label>
            <input id="c-title" className="input" value={proposal.title} maxLength={160} onChange={(e) => setProposal({ ...proposal, title: e.target.value })} />
          </div>
          {proposal.facts.map((f) => (
            <div key={f.inputId}>
              <label className="label" htmlFor={`c-${f.inputId}`}>{f.label}</label>
              <textarea
                id={`c-${f.inputId}`}
                className="input min-h-16"
                value={f.items.join("\n")}
                placeholder="None — Claude found no claim of this kind in your request."
                onChange={(e) => setProposal({ ...proposal, facts: proposal.facts.map((x) => (x.inputId === f.inputId ? { ...x, items: e.target.value.split("\n") } : x)) })}
              />
              <p className="mt-1 text-[11px] text-faint">One per line. These are shown word for word as claims you approve — check them.</p>
            </div>
          ))}
          {textInputs.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-dim">On-screen copy Claude wrote ({textInputs.length})</summary>
              <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
                {textInputs.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-faint">{k}</dt>
                    <dd>{Array.isArray(v) ? v.join(" · ") : String(v)}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-1 text-[11px] text-faint">Everything stays editable in the editor.</p>
            </details>
          )}
          {proposal.warnings.length > 0 && (
            <ul className="space-y-1 rounded-md border border-warn/30 bg-warn/5 p-3 text-xs text-warn">
              {proposal.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          {err && <p role="alert" className="text-sm text-bad">{err}</p>}
          <div className="flex items-center gap-2">
            <button className="btn btn-primary" onClick={onCreate} disabled={busy || !proposal.title.trim()}>{busy ? "Creating…" : "Create video"}</button>
            <span className="text-xs text-faint">{plan ? "Opens the editor while Claude writes the script for you to approve." : "Opens the editor with the template's scenes filled in."}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function Popover({ children, onClose, label, wide }: { children: React.ReactNode; onClose: () => void; label: string; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest("[aria-expanded]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
  return (
    <div ref={ref} role="dialog" aria-label={label} className={`absolute left-2 top-full z-30 mt-2 max-h-[70vh] space-y-3 overflow-y-auto rounded-lg border border-line bg-panel p-3 shadow-2xl ${wide ? "w-[min(560px,calc(100vw-2rem))]" : "w-[min(360px,calc(100vw-2rem))]"}`}>
      {children}
    </div>
  );
}

function Field({ label, right, children }: { label: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-dim">{label}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function Seg({ options, value, onChange }: { options: [string, string][]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex rounded-md border border-line bg-bg p-0.5" role="radiogroup">
      {options.map(([v, l]) => (
        <button key={v} role="radio" aria-checked={value === v} className={`flex-1 rounded px-2 py-1 text-xs ${value === v ? "bg-panel-2 font-medium text-ink" : "text-dim hover:text-ink"}`} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

type Suggestion = {
  templateId?: { value: string; confidence: number };
  aspect?: { value: Aspect; confidence: number };
  durationSec?: { value: number; confidence: number };
  scriptStyle?: { value: ScriptStyle; confidence: number };
  narration?: { value: boolean; confidence: number };
};

/** Jev's live suggestions for what's typed so far (debounced; nothing when no Jev key is set up). */
function useJevSuggestion(prompt: string, templateId: string | null, templates: ComposerTemplate[], attached: { image: string[]; video: string[]; audio: string[] }, active: boolean): Suggestion | null {
  const [s, setS] = useState<Suggestion | null>(null);
  const off = useRef(false);
  const text = prompt.trim();
  const counts = `${attached.image.length}/${attached.video.length}/${attached.audio.length}`;
  const candidates = useMemo(() => templates.filter((t) => t.availability.ready).map((t) => t.id), [templates]);
  useEffect(() => {
    if (!active || off.current || text.length < 12) {
      setS(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      const [image, video, audio] = counts.split("/").map(Number);
      api<{ available: boolean; suggestion?: Suggestion }>("/api/compose/suggest", { method: "POST", json: { prompt: text.slice(0, 1500), templateId, candidates, attachments: { image, video, audio } }, signal: ctrl.signal })
        .then((r) => {
          if (!r.available) off.current = true; // no Jev key: stop asking for this session
          setS(r.suggestion && Object.keys(r.suggestion).length ? r.suggestion : null);
        })
        .catch(() => {});
    }, 700);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [text, templateId, counts, candidates, active]);
  return s;
}

/** One chip per suggestion that differs from what's set; a click applies it. */
function Suggestions({ s, templates, templateId, settings, onTemplate, onSettings }: { s: Suggestion; templates: ComposerTemplate[]; templateId: string | null; settings: Settings; onTemplate: (id: string) => void; onSettings: (patch: Partial<Settings>) => void }) {
  const chips: { key: string; label: string; apply: () => void }[] = [];
  const t = s.templateId && !templateId ? templates.find((x) => x.id === s.templateId!.value) : null;
  if (t) chips.push({ key: "template", label: t.name, apply: () => onTemplate(t.id) });
  if (s.aspect && settings.aspect !== s.aspect.value) chips.push({ key: "aspect", label: s.aspect.value, apply: () => onSettings({ aspect: s.aspect!.value }) });
  if (s.durationSec && settings.durationSec !== s.durationSec.value) chips.push({ key: "length", label: `~${fmtLength(s.durationSec.value)}`, apply: () => onSettings({ durationSec: s.durationSec!.value }) });
  if (s.scriptStyle && settings.scriptStyle !== s.scriptStyle.value) chips.push({ key: "style", label: SCRIPT_STYLES[s.scriptStyle.value].label, apply: () => onSettings({ scriptStyle: s.scriptStyle!.value }) });
  if (s.narration) {
    const wantOff = !s.narration.value;
    if (wantOff !== (settings.voice === "off")) chips.push({ key: "voice", label: wantOff ? "No voiceover" : "Voiceover", apply: () => onSettings({ voice: wantOff ? "off" : "auto" }) });
  }
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2 text-xs" data-testid="jev-suggestions" aria-label="Suggested settings">
      <span className="text-faint" title="Instant suggestions from Jev for what you've typed. Click one to use it; Claude still writes the script and plans the video.">Suggested:</span>
      {chips.map((c) => (
        <button key={c.key} data-suggest={c.key} className="chip border-dashed py-0.5 hover:border-accent hover:text-ink" onClick={c.apply}>
          + {c.label}
        </button>
      ))}
      {chips.length > 1 && (
        <button className="text-accent underline" onClick={() => chips.forEach((c) => c.apply())}>
          Use all
        </button>
      )}
    </div>
  );
}
