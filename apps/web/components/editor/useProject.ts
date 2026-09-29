"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Operation, ProjectDocument } from "@vs/domain";
import { api, ApiError } from "@/lib/client/api";
import type { ProjectViewDTO, SaveState } from "./types";

export function useProject(projectId: string) {
  const [view, setView] = useState<ProjectViewDTO | null>(null);
  const [doc, setDoc] = useState<ProjectDocument | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "saved" });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const rev = useRef<string | null>(null);

  const refresh = useCallback(
    async (opts: { force?: boolean } = {}) => {
      try {
        const v = await api<ProjectViewDTO>(`/api/projects/${projectId}`);
        setView(v);
        // Never clobber edits that are still being saved.
        if (opts.force || (pending.current === 0 && v.revision.id !== rev.current)) {
          if (rev.current && v.revision.id !== rev.current && !opts.force) setNotice(`Updated: ${v.revision.action} (${v.revision.author})`);
          rev.current = v.revision.id;
          setRevisionId(v.revision.id);
          setDoc(v.doc);
          setHistory({ canUndo: v.canUndo, canRedo: v.canRedo });
          if (opts.force) setSave({ kind: "saved" });
        }
        setLoadError(null);
      } catch (e) {
        setLoadError(e instanceof ApiError ? e.message : String(e));
      }
    },
    [projectId],
  );

  useEffect(() => {
    void refresh({ force: true });
  }, [refresh]);

  // Live job/revision updates (SSE backed by persisted events).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource(`/api/projects/${projectId}/events`);
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 300);
    };
    es.addEventListener("job", soon);
    es.addEventListener("revision", (e) => {
      const r = JSON.parse((e as MessageEvent).data).revisionId;
      if (r !== rev.current) soon();
    });
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [projectId, refresh]);

  /** Apply typed operations in order; each uses the latest committed revision as its base. */
  const apply = useCallback(
    (ops: Operation[]): Promise<boolean> => {
      pending.current++;
      setSave({ kind: "saving" });
      const p = chain.current.then(async () => {
        try {
          const r = await api<{ revisionId: string; doc: ProjectDocument; canUndo: boolean; canRedo: boolean }>(`/api/projects/${projectId}/operations`, { method: "POST", json: { baseRevisionId: rev.current, ops } });
          rev.current = r.revisionId;
          setRevisionId(r.revisionId);
          setDoc(r.doc);
          setHistory({ canUndo: r.canUndo, canRedo: r.canRedo });
          pending.current--;
          if (pending.current === 0) setSave({ kind: "saved" });
          return true;
        } catch (e) {
          pending.current--;
          if (e instanceof ApiError && e.status === 409 && e.code === "stale_revision") {
            setSave({ kind: "conflict", message: "This project changed elsewhere (another tab, the assistant or the planner). Your last edit was not saved." });
          } else {
            setSave({ kind: "error", message: e instanceof ApiError ? e.message : "Save failed." });
          }
          return false;
        }
      });
      chain.current = p;
      return p;
    },
    [projectId],
  );

  const undoRedo = useCallback(
    async (dir: "undo" | "redo") => {
      await chain.current;
      setSave({ kind: "saving" });
      try {
        const r = await api<{ revisionId: string; doc: ProjectDocument; canUndo: boolean; canRedo: boolean }>(`/api/projects/${projectId}/${dir}`, { method: "POST", json: { baseRevisionId: rev.current } });
        rev.current = r.revisionId;
        setRevisionId(r.revisionId);
        setDoc(r.doc);
        setHistory({ canUndo: r.canUndo, canRedo: r.canRedo });
        setSave({ kind: "saved" });
        void refresh();
      } catch (e) {
        setSave({ kind: "error", message: e instanceof ApiError ? e.message : String(e) });
      }
    },
    [projectId, refresh],
  );

  // After edits settle, refresh storyboard keyframes (real frames of the composition).
  const kfTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!view || !revisionId) return;
    const active = view.jobs.some((j) => j.type === "keyframes" && ["queued", "running"].includes(j.status));
    const stale = doc?.scenes.some((s) => !view.keyframes[s.id]?.fresh);
    if (active || !stale) return;
    clearTimeout(kfTimer.current);
    kfTimer.current = setTimeout(() => {
      if (pending.current === 0) void api(`/api/projects/${projectId}/keyframes`, { method: "POST", json: { revisionId: rev.current } }).catch(() => {});
    }, 2500);
    return () => clearTimeout(kfTimer.current);
  }, [view, revisionId, doc, projectId]);

  return { view, doc, revisionId, save, history, apply, undoRedo, refresh, loadError, notice, clearNotice: () => setNotice(null), revRef: rev };
}
