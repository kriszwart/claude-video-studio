"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { AssetPicker } from "@/components/AssetPicker";
import { useClaudeStatus } from "@/lib/client/claude";
import { api, ApiError } from "@/lib/client/api";

interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  family: string;
  preset: string | null;
  builtin: boolean;
  version: number;
  defaultAspect: string;
  supportedAspects: string[];
  duration: { minSec: number; maxSec: number; defaultSec: number };
  tags: { purpose: string[]; generatedMedia: string };
  providers: { required: string[]; optional: string[] };
  availability: { ready: boolean; workerOnline: boolean; missingRequired: string[]; missingOptional: string[] };
}
interface InputField {
  id: string;
  label: string;
  kind: string;
  required: boolean;
  help: string;
  maxLength?: number;
  maxItems?: number;
  options?: string[];
  default?: string | number | string[];
}
interface BrandKit { id: string; name: string }

export default function NewProjectPage() {
  return (
    <Suspense fallback={<p className="p-6 text-dim">Loading…</p>}>
      <NewProject />
    </Suspense>
  );
}

function NewProject() {
  const params = useSearchParams();
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(params.get("template"));
  const [def, setDef] = useState<{ inputs: InputField[]; scenes: { purpose: string; durationSec: number; when?: string }[]; plannerGuidance: string } | null>(null);
  const [inputs, setInputs] = useState<Record<string, string | number | string[]>>({});
  const [title, setTitle] = useState("");
  const [aspect, setAspect] = useState("16:9");
  const [duration, setDuration] = useState(30);
  const [brandKits, setBrandKits] = useState<BrandKit[]>([]);
  const [brandKitId, setBrandKitId] = useState("");
  const [claudeStatus] = useClaudeStatus();
  const claude = !!claudeStatus?.readiness.available;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ templates: TemplateSummary[] }>("/api/templates").then((r) => setTemplates(r.templates));
    api<{ brandKits: BrandKit[] }>("/api/brand-kits").then((r) => setBrandKits(r.brandKits));
  }, []);
  const tpl = templates.find((t) => t.id === templateId);
  useEffect(() => {
    if (!templateId) return;
    api<{ definition: typeof def & { defaultAspect: string; duration: { defaultSec: number } } }>(`/api/templates/${templateId}`).then((r) => {
      setDef(r.definition);
      setAspect(r.definition!.defaultAspect);
      setDuration(r.definition!.duration.defaultSec);
      setInputs(Object.fromEntries(r.definition!.inputs.filter((i) => i.default !== undefined && !["image", "images", "audio", "video"].includes(i.kind)).map((i) => [i.id, i.default!])));
    });
  }, [templateId]);

  const missing = useMemo(() => (def?.inputs ?? []).filter((f) => f.required && !has(inputs[f.id])).map((f) => f.label), [def, inputs]);

  if (!templateId || !tpl) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-6">
        <h1 className="mb-1 text-xl font-semibold">Choose a template</h1>
        <p className="mb-5 text-sm text-dim">Every template produces a real rendered video. Unavailable ones say why.</p>
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <li key={t.id} className="card flex flex-col p-4">
              <div className="mb-1 flex items-center gap-2">
                <span className="font-medium">{t.name}</span>
                {!t.builtin && <span className="chip">Custom</span>}
                {t.preset && <span className="chip">Preset</span>}
              </div>
              <p className="mb-3 flex-1 text-sm text-dim">{t.description}</p>
              <div className="mb-3 flex flex-wrap gap-1">
                <span className="chip">{t.supportedAspects.join(" · ")}</span>
                <span className="chip">{t.duration.defaultSec}s default</span>
                <span className="chip">{t.tags.generatedMedia === "none" ? "No generation needed" : t.tags.generatedMedia === "optional" ? "Generation optional" : "Needs generated media"}</span>
              </div>
              {!t.availability.ready && (
                <p className="mb-2 text-xs text-warn">
                  {!t.availability.workerOnline ? "No render worker is online." : `Needs: ${t.availability.missingRequired.join(", ")}`}
                </p>
              )}
              <button className="btn btn-primary" disabled={!t.availability.ready} onClick={() => setTemplateId(t.id)}>
                Use template
              </button>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  const create = async (plan: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ project: { id: string } }>("/api/projects", {
        method: "POST",
        idempotent: true,
        json: { templateId, title: title || String(inputs.productName ?? tpl.name), aspect, inputs, brandKitId: brandKitId || undefined, durationSec: duration, plan },
      });
      router.push(`/projects/${r.project.id}`);
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.message}${e.recovery ? ` — ${e.recovery}` : ""}` : String(e));
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <button className="btn btn-ghost mb-3 text-xs" onClick={() => setTemplateId(null)}>
        ← All templates
      </button>
      <h1 className="text-xl font-semibold">{tpl.name}</h1>
      <p className="mb-5 text-sm text-dim">{tpl.description}</p>
      <form className="space-y-5" onSubmit={(e) => e.preventDefault()}>
        <section className="card grid gap-4 p-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="title">Project title</label>
            <input id="title" className="input" value={title} placeholder={String(inputs.productName ?? tpl.name)} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
          </div>
          <div>
            <label className="label" htmlFor="aspect">Aspect ratio</label>
            <select id="aspect" className="input" value={aspect} onChange={(e) => setAspect(e.target.value)}>
              {tpl.supportedAspects.map((a) => (
                <option key={a} value={a}>{a === "16:9" ? "16:9 landscape" : a === "9:16" ? "9:16 portrait" : "1:1 square"}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="dur">Duration: {duration}s</label>
            <input id="dur" type="range" className="w-full" min={tpl.duration.minSec} max={tpl.duration.maxSec} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="bk">Brand kit</label>
            <select id="bk" className="input" value={brandKitId} onChange={(e) => setBrandKitId(e.target.value)}>
              <option value="">Default neutral brand</option>
              {brandKits.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        </section>
        <section className="card space-y-4 p-4">
          <h2 className="font-medium">Brief and assets</h2>
          {def?.inputs.filter((f) => f.id !== "durationSec").map((f) => (
            <div key={f.id} data-testid={`field-${f.id}`}>
              <label className="label" htmlFor={`in-${f.id}`}>
                {f.label} {f.required && <span className="text-bad">*</span>}
              </label>
              <InputControl field={f} value={inputs[f.id]} onChange={(v) => setInputs({ ...inputs, [f.id]: v })} />
              {f.help && <p className="mt-1 text-xs text-faint">{f.help}</p>}
            </div>
          ))}
        </section>
        <section className="card p-4 text-sm">
          <h2 className="mb-2 font-medium">Before you create</h2>
          <ul className="space-y-1 text-dim">
            <li>{missing.length ? <span className="text-warn">Missing required inputs: {missing.join(", ")}</span> : "All required inputs are filled."}</li>
            <li>Paid operations: {tpl.tags.generatedMedia === "none" ? "none — rendering happens on your own worker." : "optional generated media is only submitted after you approve a budget."}</li>
            <li>
              AI planning{" "}
              {!claudeStatus
                ? "— checking Claude…"
                : claudeStatus.readiness.mode === "api"
                  ? `uses the separately billed Claude API key (${claude ? "configured" : "not configured"}).`
                  : claudeStatus.readiness.mode === "off"
                    ? "is turned off."
                    : `uses your Claude plan through Claude Code (${claude ? "ready" : "not ready"}); it counts toward your plan's usage limits and never falls back to paid API billing.`}
            </li>
          </ul>
        </section>
        {err && <p role="alert" className="text-sm text-bad">{err}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" disabled={busy || missing.length > 0 || !claude} onClick={() => create(true)} title={claude ? "" : claudeStatus?.readiness.message ?? "Checking Claude…"}>
            Create and plan storyboard with Claude
          </button>
          <button type="button" className="btn" disabled={busy || missing.length > 0} onClick={() => create(false)}>
            Create from template (no AI)
          </button>
          {!claude && (
            <span className="self-center text-xs text-faint">
              {claudeStatus?.readiness.message ?? "Checking Claude…"} <Link href={claudeStatus?.readiness.setupUrl ?? "/settings#claude"} className="text-accent underline">Set up Claude</Link> or build manually.
            </span>
          )}
        </div>
      </form>
    </main>
  );
}

function has(v: unknown) {
  return Array.isArray(v) ? v.some((x) => String(x).trim()) : v !== undefined && String(v).trim() !== "";
}

function InputControl({ field, value, onChange }: { field: InputField; value: unknown; onChange: (v: string | number | string[]) => void }) {
  const id = `in-${field.id}`;
  switch (field.kind) {
    case "longtext":
      return <textarea id={id} className="input min-h-20" value={String(value ?? "")} maxLength={field.maxLength} onChange={(e) => onChange(e.target.value)} />;
    case "facts":
    case "list": {
      const list = Array.isArray(value) ? value : [];
      return (
        <textarea
          id={id}
          className="input min-h-20"
          placeholder={`One per line${field.maxItems ? ` (up to ${field.maxItems})` : ""}`}
          value={list.join("\n")}
          onChange={(e) => onChange(e.target.value.split("\n").slice(0, field.maxItems ?? 20))}
        />
      );
    }
    case "number":
      return <input id={id} type="number" className="input" value={String(value ?? "")} onChange={(e) => onChange(Number(e.target.value))} />;
    case "select":
      return (
        <select id={id} className="input" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {field.options?.map((o) => <option key={o}>{o}</option>)}
        </select>
      );
    case "image":
    case "images":
    case "audio":
    case "video":
    case "videos":
    case "subtitle": {
      const k = field.kind === "images" ? "image" : field.kind === "videos" ? "video" : field.kind === "subtitle" ? "document" : (field.kind as "image" | "audio" | "video");
      const ids = Array.isArray(value) ? value : value ? [String(value)] : [];
      return <AssetPicker kind={k} multiple={field.kind === "images" || field.kind === "videos"} max={field.maxItems} value={ids} onChange={(v) => onChange(field.kind === "images" || field.kind === "videos" ? v : (v[0] ?? ""))} />;
    }
    default:
      return <input id={id} className="input" type={field.kind === "url" ? "text" : "text"} value={String(value ?? "")} maxLength={field.maxLength} onChange={(e) => onChange(e.target.value)} />;
  }
}
