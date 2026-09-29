import type { ProjectDocument } from "@vs/domain";

export interface JobDTO {
  id: string;
  type: string;
  status: string;
  stage: string;
  progress: number | null;
  attempts: number;
  maxAttempts: number;
  revisionId: string | null;
  error: { code: string; message: string; recovery?: string } | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface ExportDTO {
  id: string;
  kind: "preview" | "final";
  revisionId: string;
  jobId: string;
  width: number;
  height: number;
  durationSec: number;
  bundleHash: string;
  createdAt: string;
  videoUrl: string;
  downloadUrl: string;
  thumbUrl: string | null;
  srtUrl: string | null;
  vttUrl: string | null;
  checks: { name: string; ok: boolean; detail: string; severity: string }[];
  loudness: { lufs: number; truePeakDb: number } | null;
  warnings: string[];
}
export interface ProjectViewDTO {
  project: { id: string; title: string; status: string; isSample: boolean; family: string; templateId: string; templateVersion: number; variantGroupId: string | null; variantLabel: string | null; budget: Record<string, number> };
  revision: { id: string; seq: number; author: string; action: string; createdAt: string };
  doc: ProjectDocument;
  canUndo: boolean;
  canRedo: boolean;
  exports: ExportDTO[];
  jobs: JobDTO[];
  keyframes: Record<string, { url: string; revisionId: string; fresh: boolean }>;
  revisions: { id: string; seq: number; author: string; action: string; createdAt: string }[];
}
export type SaveState = { kind: "saved" } | { kind: "saving" } | { kind: "error"; message: string } | { kind: "conflict"; message: string };
