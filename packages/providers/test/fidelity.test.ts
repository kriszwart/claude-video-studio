import { describe, expect, it } from "vitest";
import { runFidelityCheck, validateFidelity, type ClaudeBackend, type FidelityOutput } from "../src";

const ASPECTS = ["shape", "logo", "label", "colour", "proportions", "details"] as const;
const out = (wrong: string[] = [], verdict: FidelityOutput["verdict"] = wrong.length ? "mismatch" : "match"): FidelityOutput => ({
  verdict,
  summary: "Same bottle.",
  checks: [...ASPECTS].reverse().map((aspect) => ({ aspect, result: wrong.includes(aspect) ? "wrong" : "ok", note: wrong.includes(aspect) ? " Letters scrambled. " : "" })),
});
const img = { mediaType: "image/jpeg" as const, data: "AAAA" };

describe("product check", () => {
  it("requires every aspect once and a verdict consistent with the checks", () => {
    expect(validateFidelity(out())).toEqual([]);
    expect(validateFidelity(out(["logo"]))).toEqual([]);
    expect(validateFidelity(out(["logo"], "match")).join()).toMatch(/use "mismatch"/);
    expect(validateFidelity(out([], "mismatch")).join()).toMatch(/no aspect is "wrong"/);
    expect(validateFidelity({ ...out(), checks: out().checks.filter((c) => c.aspect !== "shape") }).join()).toMatch(/missing "shape"/);
  });

  it("sends references before take frames, repairs once, and returns checks in aspect order", async () => {
    const calls: Parameters<ClaudeBackend["structured"]>[0][] = [];
    const answers = [out(["logo"], "match"), out(["logo"])];
    const backend: ClaudeBackend = {
      kind: "subscription",
      structured: async (call) => {
        calls.push(call);
        const json = answers.shift()!;
        return { json, text: JSON.stringify(json), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, model: "m", runtime: "subscription" } };
      },
    };
    const run = await runFidelityCheck(backend, { product: "Coral bottle", references: [img, img], frames: [{ ...img, atSec: 0.4 }, { ...img, atSec: 1 }] });
    expect(calls[0]!.images!.map((i) => i.label)).toEqual(["Reference 1 (owner's product photo)", "Reference 2 (owner's product photo)", "Take frame 1 at 0.4s (generated)", "Take frame 2 at 1.0s (generated)"]);
    expect(run.attempts).toBe(2);
    expect(calls[1]!.messages.at(-1)!.content).toMatch(/use "mismatch"/);
    expect(run.output.verdict).toBe("mismatch");
    expect(run.output.checks.map((c) => c.aspect)).toEqual([...ASPECTS]);
    expect(run.output.checks[1]!.note).toBe("Letters scrambled.");
  });

  it("refuses without a reference photo", async () => {
    const backend = { kind: "subscription", structured: async () => { throw new Error("not called"); } } as unknown as ClaudeBackend;
    await expect(runFidelityCheck(backend, { product: "x", references: [], frames: [{ ...img, atSec: null }] })).rejects.toThrow(/no reference photo/);
  });
});
