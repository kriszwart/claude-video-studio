import { describe, expect, it } from "vitest";
import { applyOperations, lintScript, Operation, OperationError, wordBudget, type Script } from "@vs/domain";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate } from "@vs/templates";
import { runScriptwriter, validatePlan, validateScript, type ClaudeBackend, type PlanContext, type PlanOutput, type ScriptContext } from "../src";

const template = BUILTIN_TEMPLATES.find((t) => t.id === "motion-reel")!;
let n = 0;
const newId = (p: string) => `${p}${++n}`;
const doc = instantiateTemplate(template, { title: "Focus", brand: { ...DEFAULT_BRAND, name: "Tidewave" }, inputs: { hook: "Focus wins", headline: "Plan less, ship more", brandName: "Tidewave", points: ["Saves 3 hours a week"] }, newId });
const ctx: ScriptContext = { template, doc, style: "professor", direction: "", narrated: true, targetDurationSec: 20, newId };
const beat = (slot: string, narration: string, durationSec: number, onScreen = "Line") => ({ recipeSlot: slot, purpose: slot, narration, onScreen, durationSec });

describe("script lint", () => {
  const base: Pick<Script, "style" | "narrated" | "beats"> = { style: "professor", narrated: true, beats: [{ id: "b1", recipeSlot: "hook", purpose: "Hook", narration: "Focus time is the part of your week that meetings cannot touch.", onScreen: "Focus wins", durationSec: 5 }] };
  it("passes plain, well-paced copy", () => {
    expect(lintScript(base)).toEqual([]);
  });
  it("flags stock phrasing, pacing and dashes", () => {
    const kinds = (b: Partial<Script["beats"][number]>) => lintScript({ ...base, beats: [{ ...base.beats[0]!, ...b }] }).map((i) => i.kind);
    expect(kinds({ narration: "Let's dive in and unlock your potential with a seamless planner." })).toContain("claudism");
    expect(kinds({ narration: "It isn't about the calendar — it's about your time." })).toContain("claudism");
    expect(kinds({ narration: "word ".repeat(40), durationSec: 5 })).toContain("too_long");
    expect(kinds({ narration: "One — two — three — four." })).toContain("dashes");
    expect(wordBudget("professor", 60)).toBe(140);
  });
});

describe("script operations", () => {
  const script: Script = { style: "plain", direction: "", narrated: true, status: "draft", notes: "", next: {}, beats: [{ id: "b1", recipeSlot: "hook", purpose: "Hook", narration: "Hello.", onScreen: "Hi", durationSec: 3 }] };
  it("only the owner approves, and any edit reopens approval", () => {
    const withScript = applyOperations(doc, [{ op: "setScript", script }], "system").doc;
    expect(() => applyOperations(withScript, [{ op: "setScriptStatus", status: "approved" }], "assistant")).toThrow(OperationError);
    const approved = applyOperations(withScript, [{ op: "setScriptStatus", status: "approved" }], "user").doc;
    expect(approved.script!.status).toBe("approved");
    // Parsed as it arrives over the API, so schema defaults would show up here.
    const edited = applyOperations(approved, [Operation.parse({ op: "updateScriptBeat", beatId: "b1", patch: { narration: "Hello again." } })], "user").doc;
    expect(edited.script).toMatchObject({ status: "draft", beats: [{ narration: "Hello again.", onScreen: "Hi" }] });
  });
});

describe("shot-plan review", () => {
  it("only the owner approves the shot plan", () => {
    const pending = { ...doc, review: { status: "pending" as const, next: { voiceId: "v1" } } };
    expect(() => applyOperations(pending, [{ op: "setReviewStatus", status: "approved" }], "assistant")).toThrow(OperationError);
    expect(applyOperations(pending, [{ op: "setReviewStatus", status: "approved" }], "user").doc.review).toEqual({ status: "approved", next: { voiceId: "v1" } });
    expect(() => applyOperations(doc, [{ op: "setReviewStatus", status: "approved" }], "user")).toThrow(/no shot plan/);
  });
});

describe("scriptwriter", () => {
  it("rejects invented figures, bad slots and a wrong total length", () => {
    const v = validateScript({ beats: [beat("hook", "Used by 10,000 teams.", 5), beat("nope", "x", 3)], notes: "" }, ctx);
    expect(v.hard.join("\n")).toMatch(/10,000/);
    expect(v.hard.join("\n")).toMatch(/"nope" is not a recipe step/);
    expect(v.hard.join("\n")).toMatch(/add up to 8.0s/);
    // A figure from the brief is fine.
    expect(validateScript({ beats: [beat("hook", "It saves 3 hours a week.", 20)], notes: "" }, ctx).hard).toEqual([]);
  });

  it("repairs stock phrasing, then returns a draft with fresh beat ids", async () => {
    const answers = [
      { beats: [beat("hook", "Let's dive in to focus time, the hours in your week that meetings are not allowed to touch.", 10), beat("kinetic", "When those hours are protected, you plan less and ship more of the work that matters.", 10)], notes: "n" },
      { beats: [beat("hook", "Focus time is the part of your week that meetings are not allowed to touch.", 10), beat("kinetic", "When those hours are protected, you plan less and ship more of the work that matters.", 10)], notes: "n" },
    ];
    const follow: string[] = [];
    const backend: ClaudeBackend = {
      kind: "subscription",
      structured: async (call) => {
        follow.push(call.messages.at(-1)!.content);
        const json = answers.shift()!;
        return { json, text: JSON.stringify(json), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, model: "m", runtime: "subscription" } };
      },
    };
    const run = await runScriptwriter(backend, ctx);
    expect(run.attempts).toBe(2);
    expect(follow[1]).toMatch(/Stock phrasing/);
    expect(run.script).toMatchObject({ status: "draft", style: "professor", narrated: true });
    expect(run.script.beats[0]!.id).toMatch(/^beat/);
    expect(run.remaining).toEqual([]);
  });
});

describe("planner with an approved script", () => {
  it("requires one scene per beat with the narration verbatim", () => {
    const script: Script = { style: "plain", direction: "", narrated: true, status: "approved", notes: "", next: {}, beats: [{ id: "b1", recipeSlot: "hook", purpose: "Hook", narration: "Focus time is protected time.", onScreen: "Focus wins", durationSec: 3 }] };
    const scripted = { ...doc, script };
    const pctx: PlanContext = { template, doc: scripted, assets: [], targetDurationSec: 20, newId };
    const scene = { recipeSlot: "hook", purpose: "Hook", layout: "kinetic", durationSec: 3, transition: "cut" as const, motionIntensity: 0.5, narration: "Focus time is protected time.", texts: [{ slot: "headline", role: "headline" as const, text: "Focus wins", approvedFactId: null }], media: [] };
    const ok: PlanOutput = { rationale: "", scenes: [scene], omitted: [], warnings: [] };
    expect(validatePlan(ok, pctx)).toEqual([]);
    const changed = validatePlan({ ...ok, scenes: [{ ...scene, narration: "Focus time matters a lot." }] }, pctx).map((i) => i.message).join();
    expect(changed).toMatch(/verbatim/);
    expect(validatePlan({ ...ok, scenes: [scene, scene] }, pctx).map((i) => i.message).join()).toMatch(/one scene per beat/);
  });
});
