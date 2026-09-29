/**
 * Undo/redo backed by immutable revisions. Each revision records which logical
 * state it represents plus undo/redo stacks of logical revision ids. Undo and redo
 * create *new* revisions (history is never rewritten), so an export pinned to an
 * older revision is never affected.
 */
export interface RevisionHistoryMeta {
  logicalId: string;
  undoStack: string[];
  redoStack: string[];
}

const MAX_STACK = 100;

export function historyForEdit(current: RevisionHistoryMeta, newRevisionId: string): RevisionHistoryMeta {
  return { logicalId: newRevisionId, undoStack: [...current.undoStack, current.logicalId].slice(-MAX_STACK), redoStack: [] };
}

export function historyForUndo(current: RevisionHistoryMeta): { target: string; meta: RevisionHistoryMeta } | null {
  const target = current.undoStack.at(-1);
  if (!target) return null;
  return {
    target,
    meta: { logicalId: target, undoStack: current.undoStack.slice(0, -1), redoStack: [...current.redoStack, current.logicalId].slice(-MAX_STACK) },
  };
}

export function historyForRedo(current: RevisionHistoryMeta): { target: string; meta: RevisionHistoryMeta } | null {
  const target = current.redoStack.at(-1);
  if (!target) return null;
  return {
    target,
    meta: { logicalId: target, undoStack: [...current.undoStack, current.logicalId].slice(-MAX_STACK), redoStack: current.redoStack.slice(0, -1) },
  };
}

export function initialHistory(revisionId: string): RevisionHistoryMeta {
  return { logicalId: revisionId, undoStack: [], redoStack: [] };
}
