"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import type { JobDTO } from "./types";

interface Issue {
  code: string;
  severity: "hard" | "creative";
  message: string;
  atSec?: number;
  repairable: boolean;
}
interface Report {
  id: string;
  verdict: "ready" | "needs_review" | "failed";
  revisionId: string;
  createdAt: string;
  report: {
    stopReason: string;
    maxRepairPasses: number;
    repairPassesUsed: number;
    passes: { pass: number; revisionId: string; sampledTimes: number[]; issues: Issue[]; repairs: { op: string; target: string; detail: string }[]; evidence: { timeSec: number; assetId: string; why: string }[] }[];
    technical: { name: string; ok: boolean; detail: string; severity: string }[];
    audio: { loudness: { lufs: number | null; truePeakDb: number | null } | null; truePeakOk: boolean };
    temporal: { timeSec: number; assetId: string }[];
    unresolved: Issue[];
    limitations: string[];
    elapsedSec: number;
  };
}
const VERDICT = { ready: ["Ready", "text-emerald-400"], needs_review: ["Needs review", "text-amber-400"], failed: ["Failed", "text-red-400"] } as const;

/** Bounded render–review–repair (FR-18): run it, then read exactly what was checked and changed. */
export function QualityPanel({ projectId, revisionId, jobs, blocking, loop, onLoop }: { projectId: string; revisionId: string; jobs: JobDTO[]; blocking: boolean; loop?: boolean; onLoop?: (loop: boolean) => void }) {
  const [reports, setReports] = useState<Report[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const running = jobs.find((j) => j.type === "quality_review" && ["queued", "running"].includes(j.status));
  const load = useCallback(() => api<{ reports: Report[] }>(`/api/projects/${projectId}/quality`).then((r) => setReports(r.reports)), [projectId]);
  useEffect(() => {
    void load();
  }, [load, running?.status]);
  const latest = reports[0];
  useEffect(() => {
    if (!latest) return;
    const ids = [...latest.report.passes.flatMap((p) => p.evidence.map((e) => e.assetId)), ...latest.report.temporal.map((t) => t.assetId)];
    void (async () => {
      const u: Record<string, string> = {};
      for (const id of ids) u[id] = (await api<{ asset: { url: string } }>(`/api/assets/${id}`)).asset.url;
      setUrls(u);
    })();
  }, [latest]);

  return (
    <section className="space-y-2" aria-labelledby="qa-h">
      <h4 id="qa-h" className="label">Draft quality review</h4>
      <button className="btn" disabled={!!running || blocking} onClick={async () => { setErr(null); try { await api(`/api/projects/${projectId}/quality`, { method: "POST", idempotent: true, json: { revisionId, maxRepairPasses: 2 } }); } catch (x) { setErr(x instanceof ApiError ? x.message : String(x)); } }}>
        {running ? `Reviewing… ${running.stage}` : "Review & repair draft"}
      </button>
      <p className="text-[11px] text-faint">Checks sample frames (hero, transitions, captions), fonts, text fit and size on a phone, captions, and the rendered file frame by frame for one-frame glitches. Up to two automatic layout/timing repairs; text, claims and locked scenes are never changed.</p>
      {onLoop && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!loop} onChange={(e) => onLoop(e.target.checked)} /> Made to loop: check that the last frame matches the first (feeds replay videos)
        </label>
      )}
      {err && <p role="alert" className="text-xs text-bad">{err}</p>}
      {latest && (
        <div className="card space-y-2 p-2.5 text-xs" data-testid="quality-report">
          <p>
            <strong className={VERDICT[latest.verdict][1]}>{VERDICT[latest.verdict][0]}</strong> · revision {latest.revisionId.slice(-6)} · {latest.report.passes.length} review pass(es), {latest.report.repairPassesUsed}/{latest.report.maxRepairPasses} repair passes · stopped: {latest.report.stopReason} · {latest.report.elapsedSec}s
          </p>
          {latest.report.passes.map((p) => (
            <div key={p.pass} className="border-t border-line pt-1">
              <p className="font-medium">Pass {p.pass}: {p.issues.length} issue(s), {p.sampledTimes.length} frames sampled</p>
              <ul className="list-disc pl-4">{p.issues.map((i, k) => <li key={k}>{i.message}{i.atSec !== undefined ? ` (at ${i.atSec.toFixed(2)} s)` : ""}{!i.repairable ? " — not auto-repairable" : ""}</li>)}</ul>
              {p.repairs.length > 0 && <ul className="pl-4 text-emerald-400">{p.repairs.map((r, k) => <li key={k}>Repaired: {r.target} — {r.detail}</li>)}</ul>}
              <div className="mt-1 flex flex-wrap gap-1">
                {p.evidence.map((e) => urls[e.assetId] && (
                  <figure key={e.assetId} className="w-28">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={urls[e.assetId]} alt={`Evidence at ${e.timeSec.toFixed(2)} s (${e.why})`} className="rounded" />
                    <figcaption className="text-[10px] text-faint">{e.timeSec.toFixed(2)} s · {e.why}</figcaption>
                  </figure>
                ))}
              </div>
            </div>
          ))}
          <p className="border-t border-line pt-1">Technical: {latest.report.technical.filter((c) => c.severity === "hard").every((c) => c.ok) ? "all hard checks passed" : latest.report.technical.filter((c) => !c.ok).map((c) => c.name).join(", ")}{typeof latest.report.audio.loudness?.lufs === "number" && Number.isFinite(latest.report.audio.loudness.lufs) ? ` · ${latest.report.audio.loudness.lufs.toFixed(1)} LUFS` : " · no programme loudness (silent)"}{typeof latest.report.audio.loudness?.truePeakDb === "number" ? `, peak ${latest.report.audio.loudness.truePeakDb.toFixed(1)} dBTP` : ""}</p>
          {latest.report.temporal.length > 0 && (
            <div className="flex flex-col gap-1">
              {latest.report.temporal.map((t) => urls[t.assetId] && (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={t.assetId} src={urls[t.assetId]} alt={`Frames around the transition at ${t.timeSec.toFixed(2)} s`} className="rounded" />
              ))}
            </div>
          )}
          {latest.report.unresolved.length > 0 && <p className="text-amber-400">Unresolved: {latest.report.unresolved.map((i) => i.message).join(" ")}</p>}
          <details><summary className="cursor-pointer text-faint">Limitations</summary><ul className="list-disc pl-4 text-faint">{latest.report.limitations.map((l) => <li key={l}>{l}</li>)}</ul></details>
        </div>
      )}
    </section>
  );
}
