"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import type { JobDTO } from "./types";

type Pictures = "none" | "fluxtify" | "lanternist";
type Result = { projectId: string; editorUrl: string | null; reviewUrl: string | null; shots: number; pictures: { made: number; failed: number }; pictureSource?: Pictures; linksExpire?: string | null };

/** Send the shot plan to Lanternist for storyboarding and client review. */
export function LanternistPanel({ projectId, jobs }: { projectId: string; jobs: JobDTO[] }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [hosting, setHosting] = useState(false);
  const [reviewLink, setReviewLink] = useState(true);
  const [pictures, setPictures] = useState<Pictures>("none");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ providers: { provider: string; configured: boolean }[] }>("/api/settings/providers")
      .then((r) => {
        setConfigured(!!r.providers.find((p) => p.provider === "lanternist")?.configured);
        setHosting(!!r.providers.find((p) => p.provider === "share")?.configured);
      })
      .catch(() => setConfigured(false));
  }, []);
  const mine = jobs.filter((j) => j.type === "send_lanternist");
  const running = mine.find((j) => ["queued", "running"].includes(j.status));
  const last = mine.find((j) => j.status === "succeeded");
  const failed = mine[0] && mine[0].status === "failed" ? mine[0] : null;
  const result = last?.result as Result | undefined;
  return (
    <section className="space-y-2 text-xs" aria-labelledby="lanternist-h" data-testid="lanternist">
      <h3 id="lanternist-h" className="panel-title">Lanternist</h3>
      <p className="text-faint">Send the shot plan (one shot per scene with timing, narration and an image prompt) to Lanternist for storyboarding and client sign-off. Your Fluxtify project doesn&apos;t change.</p>
      {configured === false ? (
        <p className="text-dim">
          Add your Lanternist access token in <a className="underline" href="/settings#provider-lanternist">Settings → Lanternist</a> first.
        </p>
      ) : (
        <>
          <label className="flex items-center gap-2"><input type="checkbox" checked={reviewLink} onChange={(e) => setReviewLink(e.target.checked)} /> Create a review link (public; anyone with it can view and comment)</label>
          <fieldset className="space-y-1">
            <legend className="text-dim">Pictures for the shots</legend>
            <label className="flex items-center gap-2"><input type="radio" name="lanternist-pictures" checked={pictures === "none"} onChange={() => setPictures("none")} /> No pictures</label>
            <label className="flex items-center gap-2">
              <input type="radio" name="lanternist-pictures" checked={pictures === "fluxtify"} disabled={!hosting} onChange={() => setPictures("fluxtify")} /> This project&apos;s frames (one per scene, uploaded to your picture hosting; anyone with a link can see it)
            </label>
            {!hosting && (
              <p className="pl-5 text-faint">
                Set up <a className="underline" href="/settings#provider-share">Settings → Picture hosting</a> to send your own frames.
              </p>
            )}
            <label className="flex items-center gap-2"><input type="radio" name="lanternist-pictures" checked={pictures === "lanternist"} onChange={() => setPictures("lanternist")} /> Lanternist draws them (about 20 s each; uses your Lanternist credits)</label>
          </fieldset>
          <button
            className="btn"
            disabled={!configured || !!running}
            onClick={async () => {
              setErr(null);
              try {
                await api(`/api/projects/${projectId}/lanternist`, { method: "POST", idempotent: true, json: { reviewLink, pictures } });
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : String(e));
              }
            }}
          >
            {running ? `Sending… ${running.stage}` : "Send to Lanternist"}
          </button>
        </>
      )}
      {err && <p className="text-bad">{err}</p>}
      {failed && !running && <p className="text-bad">{failed.error?.message} {failed.error?.recovery}</p>}
      {result && (
        <p className="text-dim" data-testid="lanternist-result">
          Sent {result.shots} shots{result.pictures.made ? `, ${result.pictures.made} pictures ${result.pictureSource === "fluxtify" ? "attached" : "drawn"}` : ""}{result.pictures.failed ? ` (${result.pictures.failed} failed)` : ""}.{" "}
          {result.linksExpire && `Picture links work until ${new Date(result.linksExpire).toLocaleDateString()}. `}
          {result.editorUrl && <a className="underline" href={result.editorUrl} target="_blank" rel="noreferrer">Open in Lanternist</a>}
          {result.reviewUrl && (
            <>
              {" · "}
              <a className="underline" href={result.reviewUrl} target="_blank" rel="noreferrer">Review link</a>
            </>
          )}
        </p>
      )}
    </section>
  );
}
