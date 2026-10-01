"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import { TemplatePoster, type Poster } from "@/components/TemplatePoster";

interface T {
  id: string;
  name: string;
  description: string;
  family: string;
  poster: Poster | null;
  preset: string | null;
  builtin: boolean;
  version: number;
  supportedAspects: string[];
  defaultAspect: string;
  duration: { minSec: number; maxSec: number; defaultSec: number };
  tags: { purpose: string[]; generatedMedia: string };
  providers: { required: string[]; optional: string[] };
  availability: { ready: boolean; workerOnline: boolean; missingRequired: string[]; missingOptional: string[] };
}

export default function Templates() {
  const [items, setItems] = useState<T[]>([]);
  const [purpose, setPurpose] = useState("");
  const [orientation, setOrientation] = useState("");
  const [maxDur, setMaxDur] = useState(0);
  const [gen, setGen] = useState("");
  useEffect(() => {
    api<{ templates: T[] }>("/api/templates").then((r) => setItems(r.templates));
  }, []);
  const purposes = useMemo(() => [...new Set(items.flatMap((t) => t.tags.purpose))].sort(), [items]);
  const shown = items.filter((t) => (!purpose || t.tags.purpose.includes(purpose)) && (!orientation || t.supportedAspects.includes(orientation)) && (!maxDur || t.duration.defaultSec <= maxDur) && (!gen || t.tags.generatedMedia === gen));
  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <h1 className="mb-4 text-xl font-semibold">Templates</h1>
      <div className="mb-5 flex flex-wrap gap-2" role="group" aria-label="Filters">
        <select className="input w-auto" aria-label="Purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
          <option value="">Any purpose</option>
          {purposes.map((p) => <option key={p}>{p}</option>)}
        </select>
        <select className="input w-auto" aria-label="Orientation" value={orientation} onChange={(e) => setOrientation(e.target.value)}>
          <option value="">Any orientation</option>
          <option value="16:9">Landscape 16:9</option>
          <option value="9:16">Portrait 9:16</option>
          <option value="1:1">Square 1:1</option>
        </select>
        <select className="input w-auto" aria-label="Duration" value={maxDur} onChange={(e) => setMaxDur(Number(e.target.value))}>
          <option value={0}>Any duration</option>
          <option value={20}>≤ 20 s</option>
          <option value={40}>≤ 40 s</option>
          <option value={90}>≤ 90 s</option>
        </select>
        <select className="input w-auto" aria-label="Generated media" value={gen} onChange={(e) => setGen(e.target.value)}>
          <option value="">Any media requirement</option>
          <option value="none">No generated media</option>
          <option value="optional">Generation optional</option>
          <option value="required">Needs generated media</option>
        </select>
      </div>
      <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {shown.map((t) => (
          <li key={t.id} className="card group flex flex-col overflow-hidden">
            <TemplatePoster poster={t.poster} family={t.family} name={t.name} />
            <div className="flex flex-1 flex-col p-4">
            <div className="mb-1 flex items-center gap-2">
              <h2 className="font-medium">{t.name}</h2>
              {!t.builtin && <span className="chip">Custom</span>}
              {t.preset && <span className="chip">Preset of {t.family}</span>}
              <span className="ml-auto text-xs text-faint">v{t.version}</span>
            </div>
            <p className="mb-3 flex-1 text-sm text-dim">{t.description}</p>
            <dl className="mb-3 grid grid-cols-2 gap-1 text-xs text-dim">
              <dt className="text-faint">Formats</dt>
              <dd>{t.supportedAspects.join(", ")}</dd>
              <dt className="text-faint">Duration</dt>
              <dd>{t.duration.minSec}–{t.duration.maxSec}s (default {t.duration.defaultSec}s)</dd>
              <dt className="text-faint">Providers</dt>
              <dd>{t.providers.required.length ? `Requires ${t.providers.required.join(", ")}` : "None required"}{t.providers.optional.length ? `; optional ${t.providers.optional.join(", ")}` : ""}</dd>
            </dl>
            {!t.availability.ready ? (
              <p className="mb-2 text-xs text-warn">Unavailable: {!t.availability.workerOnline ? "no render worker online" : `needs ${t.availability.missingRequired.join(", ")}`}</p>
            ) : t.availability.missingOptional.length ? (
              <p className="mb-2 text-xs text-faint">Optional features off: {t.availability.missingOptional.join(", ")}</p>
            ) : null}
            <Link href={`/projects/new?template=${t.id}`} className={`btn btn-primary ${t.availability.ready ? "" : "pointer-events-none opacity-50"}`} aria-disabled={!t.availability.ready}>
              Start a project
            </Link>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
