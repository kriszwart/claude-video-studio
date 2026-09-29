"use client";
import { useEffect, useState } from "react";
import { BrandSnapshot, validateTimeline, type Operation, type ProjectDocument } from "@vs/domain";
import { PROFILE_PRESETS } from "@vs/templates/profiles";
import { api } from "@/lib/client/api";
import type { ProjectViewDTO } from "./types";

export function ProjectPanel({ doc, view, apply }: { doc: ProjectDocument; view: ProjectViewDTO; apply: (ops: Operation[]) => Promise<boolean> }) {
  const [kits, setKits] = useState<{ id: string; name: string; version: number; data: unknown }[]>([]);
  useEffect(() => {
    api<{ brandKits: typeof kits }>("/api/brand-kits").then((r) => setKits(r.brandKits)).catch(() => {});
  }, []);
  const issues = validateTimeline(doc);
  const kitNow = kits.find((k) => k.id === doc.brand.brandKitId);
  return (
    <div className="space-y-4 text-xs">
      {doc.characters.length > 0 && <Characters doc={doc} apply={apply} />}
      <AssetSources projectId={view.project.id} doc={doc} />
      <section>
        <h4 className="label">Aspect ratio</h4>
        <div className="flex gap-1" role="radiogroup" aria-label="Aspect ratio">
          {(["16:9", "9:16", "1:1"] as const).map((a) => (
            <button key={a} role="radio" aria-checked={doc.format.aspect === a} className={`btn text-xs ${doc.format.aspect === a ? "border-accent" : ""}`} onClick={() => apply([{ op: "setFormat", aspect: a }])}>
              {a}
            </button>
          ))}
        </div>
        <p className="mt-1 text-faint">Switching recomputes every scene’s layout for the new frame (not a crop). Text keeps its wording.</p>
        <label className="label mt-2" htmlFor="safe">Safe area</label>
        <select id="safe" className="input" value={doc.format.safeArea} onChange={(e) => apply([{ op: "setFormat", safeArea: e.target.value as "none@1" }])}>
          <option value="none@1">Title safe (4%)</option>
          <option value="reels-shorts@2026-09">Vertical social overlays (2026-09 preset)</option>
        </select>
      </section>
      <section>
        <h4 className="label">Brand</h4>
        <p className="mb-1">
          Using: <strong>{doc.brand.name || "Default brand"}</strong>
          {doc.brand.brandKitId && ` (kit v${doc.brand.brandKitVersion})`}
          {kitNow && kitNow.version !== doc.brand.brandKitVersion && <span className="text-warn"> — the kit has changed since this snapshot</span>}
        </p>
        <div className="flex gap-1">
          {Object.entries(doc.brand.colors).map(([k, v]) => (
            <span key={k} title={k} className="h-5 w-5 rounded border border-line" style={{ background: v }} />
          ))}
        </div>
        {kits.length > 0 && (
          <select
            className="input mt-2"
            value=""
            aria-label="Apply a brand kit"
            onChange={(e) => {
              const k = kits.find((x) => x.id === e.target.value);
              if (k && confirm(`Apply "${k.name}" to this project? This creates a new revision you can undo.`)) void apply([{ op: "applyBrand", brand: BrandSnapshot.parse({ ...(k.data as object), brandKitId: k.id, brandKitVersion: k.version }) }]);
            }}
          >
            <option value="">Apply a brand kit…</option>
            {kits.map((k) => (
              <option key={k.id} value={k.id}>{k.name} (v{k.version})</option>
            ))}
          </select>
        )}
      </section>
      <section>
        <h4 className="label">Creative profile (editing taste)</h4>
        <select
          className="input mb-2"
          aria-label="Apply a profile preset"
          value=""
          onChange={(e) => {
            const p = PROFILE_PRESETS[e.target.value];
            if (p) void apply([{ op: "applyCreativeProfile", profile: p }]);
          }}
        >
          <option value="">Apply a preset treatment…</option>
          {Object.entries(PROFILE_PRESETS).map(([k, p]) => (
            <option key={k} value={k}>{p.name}</option>
          ))}
        </select>
        <div className="grid grid-cols-2 gap-2">
          <label>
            Pacing
            <select className="input" value={doc.profile.pacing} onChange={(e) => apply([{ op: "applyCreativeProfile", profile: { ...doc.profile, profileId: undefined, version: undefined, pacing: e.target.value as "calm" } }])}>
              <option value="calm">Calm</option>
              <option value="balanced">Balanced</option>
              <option value="fast">Fast</option>
            </select>
          </label>
          <label>
            Type scale ×{doc.profile.typeScale.toFixed(2)}
            <input type="range" min={0.7} max={1.6} step={0.05} className="w-full" defaultValue={doc.profile.typeScale} key={doc.profile.typeScale} onMouseUp={(e) => apply([{ op: "applyCreativeProfile", profile: { ...doc.profile, profileId: undefined, version: undefined, typeScale: Number((e.target as HTMLInputElement).value) } }])} />
          </label>
        </div>
        <p className="mt-1 text-faint">Profile: {doc.profile.name}{doc.profile.version ? ` v${doc.profile.version}` : ""}</p>
      </section>
      <section>
        <h4 className="label">Captions</h4>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={doc.captions.enabled} onChange={(e) => apply([{ op: "setCaptions", captions: { enabled: e.target.checked } }])} />
          Burn in captions ({doc.captions.cues.length} cues)
        </label>
        {doc.captions.cues.length === 0 && <p className="text-faint">Captions come from narration or transcription.</p>}
      </section>
      <section>
        <h4 className="label">Checks ({issues.length})</h4>
        {issues.length === 0 ? (
          <p className="text-ok">No timing, asset or narration problems found.</p>
        ) : (
          <ul className="space-y-1">
            {issues.map((i, n) => (
              <li key={n} className={i.severity === "error" ? "text-bad" : "text-warn"}>
                {i.severity === "error" ? "Error" : "Warning"}: {i.message}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h4 className="label">History</h4>
        <ol className="max-h-48 space-y-0.5 overflow-y-auto">
          {view.revisions.map((r) => (
            <li key={r.id} className={r.id === view.revision.id ? "text-ink" : "text-faint"}>
              r{r.seq} · {r.action} · {r.author} · {new Date(r.createdAt).toLocaleTimeString()}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/** Persistent character references (T2): locked by default so edits never replace them silently. */
function Characters({ doc, apply }: { doc: ProjectDocument; apply: (ops: Operation[]) => Promise<boolean> }) {
  return (
    <section aria-labelledby="chars-h" className="space-y-2">
      <h4 id="chars-h" className="label">Characters</h4>
      {doc.characters.map((c) => (
        <div key={c.id} className="card space-y-2 p-2" data-testid={`character-${c.id}`}>
          <div className="flex items-center gap-2">
            <strong>{c.name}</strong>
            <span className="text-faint">{c.mode === "image" ? `${c.referenceAssetIds.length} reference image(s)` : `vector ${c.species}`}</span>
            <label className="ml-auto flex items-center gap-1">
              <input type="checkbox" checked={c.locked} onChange={(e) => apply([{ op: "updateCharacter", characterId: c.id, patch: { locked: e.target.checked } }])} />
              Reference locked
            </label>
          </div>
          <fieldset disabled={c.locked} className="grid grid-cols-4 gap-2 disabled:opacity-60">
            {(["body", "belly", "accent", "eye"] as const).map((k) => (
              <label key={k} className="flex flex-col gap-1">
                <span className="text-faint capitalize">{k}</span>
                <input type="color" aria-label={`${c.name} ${k} colour`} value={c.palette[k]} onChange={(e) => apply([{ op: "updateCharacter", characterId: c.id, patch: { palette: { ...c.palette, [k]: e.target.value } } }])} />
              </label>
            ))}
            {c.mode === "vector" && (
              <label className="col-span-2 flex flex-col gap-1">
                <span className="text-faint">Shape</span>
                <select className="input" value={c.species} onChange={(e) => apply([{ op: "updateCharacter", characterId: c.id, patch: { species: e.target.value as typeof c.species } }])}>
                  {["blob", "cat", "bear", "bird", "robot"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
            )}
          </fieldset>
          <p className="text-faint">The same reference is used in every scene. Scene variations change settings, props and poses — never the character itself.</p>
        </div>
      ))}
    </section>
  );
}

type AssetReq = { scene: number; purpose: string; slot: string; kind: string; source: string; asset?: { name: string; url: string | null; retrievedAt: string | null; license: string | null; rightsAcknowledged: boolean; provider: string | null } };

/** Where each media slot's asset came from, with the provenance kept for it (FR-15). */
function AssetSources({ projectId, doc }: { projectId: string; doc: ProjectDocument }) {
  const [rows, setRows] = useState<AssetReq[] | null>(null);
  useEffect(() => {
    api<{ requests: AssetReq[] }>(`/api/projects/${projectId}/asset-requests`).then((r) => setRows(r.requests)).catch(() => setRows([]));
  }, [projectId, doc]);
  if (!rows?.length) return null;
  return (
    <section aria-labelledby="src-h">
      <h4 id="src-h" className="label">Asset sources ({doc.acquisitionPolicy.replace(/-/g, " ")})</h4>
      <ul className="space-y-1" data-testid="asset-sources">
        {rows.map((r, i) => (
          <li key={i} className={r.source === "missing" ? "text-warn" : ""}>
            Scene {r.scene} · {r.slot}: <strong>{r.source.replace("-", " ")}</strong>
            {r.asset ? ` — ${r.asset.name}` : ""}
            {r.asset?.url ? <span className="text-faint"> · {r.asset.url}{r.asset.retrievedAt ? ` (retrieved ${r.asset.retrievedAt.slice(0, 10)})` : ""}</span> : null}
            {r.asset?.provider ? <span className="text-faint"> · generated by {r.asset.provider}</span> : null}
            {r.asset && !r.asset.rightsAcknowledged && r.source !== "generated" && r.source !== "sample" ? <span className="text-warn"> · usage rights not confirmed</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
