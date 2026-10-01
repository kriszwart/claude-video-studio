import type { ProjectDocument } from "@vs/domain";
import type { ExportDTO, JobDTO } from "./types";

/**
 * Guided flow: where a project stands on script → storyboard → voiceover → shots → draft →
 * review → export, derived only from the document, its jobs and its renders (nothing stored, so
 * it can never disagree with what the panels show). Steps that don't apply to a project are left
 * out; the first unfinished required step is "next".
 */

export type FlowTab = "script" | "critic" | "shots" | "audio" | "export" | "transcript" | "scene";
export type FlowAction = { kind: "tab"; tab: FlowTab } | { kind: "review" } | { kind: "render" };
export type StepState = "done" | "working" | "next" | "todo";
export interface FlowStep {
  id: "script" | "storyboard" | "edit" | "voice" | "shots" | "draft" | "review" | "export";
  label: string;
  state: StepState;
  optional?: boolean;
  /** One line on what happens now or what the owner should do. */
  hint: string;
  action: FlowAction | null;
  actionLabel?: string;
}

const ACTIVE = ["queued", "running", "waiting_provider", "cancel_requested"];
const active = (jobs: JobDTO[], type: string) => jobs.find((j) => j.type === type && ACTIVE.includes(j.status));

export function projectFlow(input: { doc: ProjectDocument; jobs: JobDTO[]; exports: ExportDTO[]; revisionId: string; blocking: string[] }): { steps: FlowStep[]; next: FlowStep | null; skipTo: FlowStep | null } {
  const { doc, jobs, exports, revisionId, blocking } = input;
  const steps: FlowStep[] = [];

  if (doc.program) {
    steps.push({ id: "edit", label: "Edit", state: "done", hint: "Cut the talk from its transcript.", action: { kind: "tab", tab: "transcript" } });
  } else {
    const writing = active(jobs, "write_script");
    if (doc.script || writing) {
      if (writing) steps.push({ id: "script", label: "Script", state: "working", hint: `Claude is writing the script (${writing.stage || "queued"}).`, action: { kind: "tab", tab: "script" }, actionLabel: "Watch" });
      else if (doc.script?.status === "draft") steps.push({ id: "script", label: "Script", state: "next", hint: "Read the script, edit any line, then approve it; the storyboard is planned from it.", action: { kind: "tab", tab: "script" }, actionLabel: "Review the script" });
      else steps.push({ id: "script", label: "Script", state: "done", hint: "Script approved.", action: { kind: "tab", tab: "script" } });
    }
    const planning = active(jobs, "plan") ?? active(jobs, "compose");
    if (planning) steps.push({ id: "storyboard", label: "Storyboard", state: "working", hint: `Claude is planning the storyboard (${planning.stage || "queued"}). You can keep editing.`, action: null });
    else if (doc.review?.status === "pending") steps.push({ id: "storyboard", label: "Storyboard", state: "next", hint: "Check each shot of the plan, revise any, then approve it.", action: { kind: "review" }, actionLabel: "Review the shot plan" });
    else if (doc.script?.status === "draft") steps.push({ id: "storyboard", label: "Storyboard", state: "todo", hint: "Planned from the approved script.", action: null });
    else steps.push({ id: "storyboard", label: "Storyboard", state: "done", hint: "Storyboard ready; edit scenes on the timeline.", action: { kind: "tab", tab: "scene" } });
  }

  const narrated = doc.scenes.filter((s) => s.script.narration.trim());
  if (!doc.program && narrated.length) {
    const voiced = new Set(doc.audio.filter((t) => t.kind === "voiceover" && t.anchor.type === "scene").map((t) => (t.anchor as { sceneId: string }).sceneId));
    const missing = narrated.filter((s) => !voiced.has(s.id)).length;
    const tts = active(jobs, "tts");
    if (tts) steps.push({ id: "voice", label: "Voiceover", state: "working", hint: `Recording the voiceover (${tts.stage || "queued"}).`, action: { kind: "tab", tab: "audio" }, actionLabel: "Open Audio" });
    else if (missing) steps.push({ id: "voice", label: "Voiceover", state: "next", hint: `${missing} of ${narrated.length} narrated scene${narrated.length > 1 ? "s" : ""} ha${missing > 1 ? "ve" : "s"} no voiceover yet. Pick a voice and record it.`, action: { kind: "tab", tab: "audio" }, actionLabel: "Go to voiceover" });
    else steps.push({ id: "voice", label: "Voiceover", state: "done", hint: "Voiceover recorded for every narrated scene.", action: { kind: "tab", tab: "audio" } });
  }

  const shots = doc.scenes.map((s) => s.shot).filter((s): s is NonNullable<typeof s> => !!s);
  if (shots.length) steps.push(shotStep(doc, shots, jobs));

  const rendering = jobs.find((j) => j.type === "preview" && ACTIVE.includes(j.status) && j.revisionId === revisionId);
  const drafted = exports.some((e) => e.revisionId === revisionId);
  if (rendering) steps.push({ id: "draft", label: "Draft", state: "working", hint: `Rendering a draft of this version (${rendering.stage || "queued"}).`, action: null });
  else if (drafted) steps.push({ id: "draft", label: "Draft", state: "done", hint: "Draft rendered for this version.", action: null });
  else if (blocking.length) steps.push({ id: "draft", label: "Draft", state: "next", hint: `Fix first: ${blocking[0]}`, action: { kind: "tab", tab: "scene" }, actionLabel: "Open the scene" });
  else steps.push({ id: "draft", label: "Draft", state: "next", hint: "Render a draft of this version to watch it with real audio and timing. Drafts are free.", action: { kind: "render" }, actionLabel: "Render a draft" });

  const critiquing = active(jobs, "critique");
  const critiqued = jobs.some((j) => j.type === "critique" && j.status === "succeeded" && j.revisionId === revisionId);
  if (critiquing) steps.push({ id: "review", label: "Critic", optional: true, state: "working", hint: "Claude is watching the draft.", action: { kind: "tab", tab: "critic" }, actionLabel: "Open Critic" });
  else if (critiqued) steps.push({ id: "review", label: "Critic", optional: true, state: "done", hint: "Claude reviewed this version.", action: { kind: "tab", tab: "critic" } });
  else steps.push({ id: "review", label: "Critic", optional: true, state: "next", hint: "Optional: have Claude watch the draft and list what to fix before you export.", action: { kind: "tab", tab: "critic" }, actionLabel: "Go to critic" });

  const exporting = jobs.find((j) => j.type === "export" && ACTIVE.includes(j.status));
  const exported = exports.some((e) => e.kind === "final" && e.revisionId === revisionId);
  if (exporting) steps.push({ id: "export", label: "Export", state: "working", hint: `Exporting (${exporting.stage || "queued"}).`, action: { kind: "tab", tab: "export" }, actionLabel: "Open Export" });
  else if (exported) steps.push({ id: "export", label: "Export", state: "done", hint: "Exported. Download it from the Export tab.", action: { kind: "tab", tab: "export" }, actionLabel: "Open Export" });
  else steps.push({ id: "export", label: "Export", state: "next", hint: "Run the quality check and export the final video.", action: { kind: "tab", tab: "export" }, actionLabel: "Go to export" });

  // Only the first unfinished step is "next"; later ones wait. When that step is optional,
  // the bar also offers the step after it.
  let next: FlowStep | null = null;
  for (const s of steps) {
    if (s.state === "done") continue;
    if (s.state === "working") {
      next ??= s;
      continue;
    }
    if (next) s.state = "todo";
    else next = s;
  }
  const after = next?.optional ? steps[steps.indexOf(next) + 1] ?? null : null;
  return { steps, next, skipTo: after };
}

type Shot = NonNullable<ProjectDocument["scenes"][number]["shot"]>;

function shotStep(doc: ProjectDocument, shots: Shot[], jobs: JobDTO[]): FlowStep {
  const base = { id: "shots" as const, label: "Shots", action: { kind: "tab" as const, tab: "shots" as const } };
  const generating = active(jobs, "generate_media");
  if (generating) return { ...base, state: "working", hint: `Generating shots (${generating.stage || "queued"}).`, actionLabel: "Open Shots" };
  const usedReview = (s: ProjectDocument["scenes"][number]) => s.shot?.candidates.find((c) => c.assetId === s.shot!.acceptedAssetId)?.review;
  const off = doc.scenes.findIndex((s) => usedReview(s)?.claude?.verdict === "mismatch" && usedReview(s)?.decision !== "approved");
  if (off >= 0) return { ...base, state: "next", hint: `Claude says the take used in scene ${off + 1} doesn't match your product. Check it, then keep it (Matches) or replace it.`, actionLabel: "Go to shots" };
  const open = shots.filter((s) => !s.acceptedAssetId);
  if (!open.length) {
    const auto = shots.filter((s) => s.autoAccepted).length;
    return { ...base, state: "done", hint: auto ? `All shots in place; ${auto} were accepted automatically and are worth a look.` : "All shots in place." };
  }
  const supplied = open.filter((s) => s.source === "supplied").length;
  const generated = open.filter((s) => s.source === "generate");
  const needKeyframe = generated.filter((s) => s.kind === "video" && !s.keyframeAssetId).length;
  const failed = generated.filter((s) => s.status === "failed").length;
  const ready = generated.filter((s) => s.status === "ready").length;
  if (ready) return { ...base, state: "next", hint: `${ready} shot${ready > 1 ? "s have" : " has"} takes waiting; pick one for each.`, actionLabel: "Go to takes" };
  if (failed) return { ...base, state: "next", hint: `${failed} shot${failed > 1 ? "s" : ""} failed to generate; see why and retry or replace.`, actionLabel: "Open Shots" };
  if (needKeyframe) return { ...base, state: "next", hint: `Generate a keyframe for ${needKeyframe} video shot${needKeyframe > 1 ? "s" : ""}, then check them as an animatic before paying for video.`, actionLabel: "Go to keyframes" };
  if (doc.animatic?.status === "pending" && generated.length) return { ...base, state: "next", hint: "Watch the animatic (keyframes with voiceover and music) and approve it before video is generated.", actionLabel: "Go to the animatic" };
  if (generated.length) return { ...base, state: "next", hint: `${generated.length} shot${generated.length > 1 ? "s" : ""} still to generate (uses your provider budget).`, actionLabel: "Go to shots" };
  return { ...base, state: "next", hint: `${supplied} shot${supplied > 1 ? "s need" : " needs"} your footage.`, actionLabel: "Go to shots" };
}
