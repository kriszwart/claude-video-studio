import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { ART, createProject } from "./helpers";

/**
 * PRD §28 gates against the Claude Agent SDK TEST DOUBLE (scripts/fake-claude-sdk.mjs, enabled
 * by STUDIO_CLAUDE_SDK_DOUBLE on the dev server and worker). The double stands in for a
 * signed-in Claude Code; the live subscription check (A31 with a real login) is reported
 * separately in docs/STATUS.md.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const STATE = process.env.STUDIO_CLAUDE_SDK_DOUBLE_STATE ?? join(ROOT, "data", "fake-claude.json");
const LOG = `${STATE}.log.jsonl`;
const DB = process.env.DATABASE_URL ?? "postgresql://studio:studio@127.0.0.1:5432/studio";

type Scenario = "signed_out" | "api_key" | "max" | "max_limit";
async function scenario(request: APIRequestContext, s: Scenario) {
  writeFileSync(STATE, JSON.stringify({ scenario: s }));
  const r = await request.post("/api/settings/claude");
  expect(r.status()).toBe(200);
  return r.json();
}
const logLines = () => {
  try {
    return readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
async function waitJob(request: APIRequestContext, id: string, done: string[], timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const j = (await (await request.get(`/api/jobs/${id}`)).json()).job;
    if (done.includes(j.status)) return j;
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${id} stuck in ${j.status}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
/** Addresses listening on a TCP port, from /proc/net/tcp{,6} (Linux). */
function listeners(port: number): string[] {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const out: string[] = [];
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const [, local, , state] = line.trim().split(/\s+/);
      if (!local || state !== "0A" || !local.endsWith(`:${hexPort}`)) continue;
      const hex = local.split(":")[0]!;
      if (hex.length === 8) out.push(hex.match(/../g)!.reverse().map((b) => parseInt(b, 16)).join("."));
      else out.push(/^0+$/.test(hex) ? "::" : hex === "00000000000000000000000001000000" ? "::1" : /^0000000000000000FFFF0000/.test(hex) ? hex.slice(24).match(/../g)!.reverse().map((b) => parseInt(b, 16)).join(".") : hex);
    }
  }
  return [...new Set(out)];
}
const psql = (q: string) => execFileSync("psql", [DB, "-Atc", q]).toString().trim();

test.describe.serial("Claude subscription runtime (A31–A33, SDK test double)", () => {
  test.afterAll(async ({ request }) => {
    await scenario(request, "signed_out");
  });

  test("A31: subscription runtime is the default, needs no API key, and reports the observed mode", async ({ request, page }) => {
    const out = await scenario(request, "signed_out");
    expect(out.readiness).toMatchObject({ mode: "subscription", available: false, setupUrl: "/settings#claude" });
    expect(out.runtime.lastCheck.state).toBe("login_required");

    // An API-key / Console login is refused in subscription mode — nothing is sent.
    const api = await scenario(request, "api_key");
    expect(api.readiness.available).toBe(false);
    expect(api.runtime.lastCheck).toMatchObject({ state: "billing_mismatch", observed: "api_key" });
    const created = await createProject(request, { templateId: "motion-reel", title: "A31 subscription", inputs: { hook: "Hi", headline: "Plan less", brandName: "Tidewave" } });
    const id = created.project.id;
    const rev = (await (await request.get(`/api/projects/${id}`)).json()).revision.id;
    const blocked = await request.post(`/api/projects/${id}/assistant`, { data: { request: "Slow down scene one", baseRevisionId: rev } });
    expect(blocked.status()).toBe(412);
    expect((await blocked.json()).error.code).toBe("claude_unavailable");

    const ready = await scenario(request, "max");
    expect(ready.readiness).toMatchObject({ mode: "subscription", available: true });
    expect(ready.runtime).toMatchObject({ apiKeyConfigured: false, lastCheck: { ok: true, observed: "subscription", plan: "max" } });

    const before = logLines().length;
    const r = await request.post(`/api/projects/${id}/assistant`, { data: { request: "Slow down scene one", baseRevisionId: rev } });
    expect(r.status()).toBe(202);
    const job = await waitJob(request, (await r.json()).job.id, ["succeeded", "failed", "paused"]);
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    expect(job.result.status).toBe("applied");
    const v = await (await request.get(`/api/projects/${id}`)).json();
    expect(v.doc.scenes[0].durationFrames).toBe(7 * v.doc.format.fps);

    // Scoped invocation: no built-in tools, no user settings, no saved session, a per-project scratch dir,
    // and none of the billing-override variables in the child environment.
    const calls = logLines().slice(before).filter((l) => l.event === "prompt");
    expect(calls.length).toBe(1);
    const c = calls[0];
    expect(c).toMatchObject({ tools: [], allowedTools: [], settingSources: [], persistSession: false, permissionMode: "dontAsk", strictMcpConfig: true, outputFormat: "json_schema" });
    expect(c.cwd).toContain(`/claude-video-studio/${id}-`);
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) expect(c.envNames).not.toContain(k);

    // Usage is recorded as plan usage, with no invented charge.
    const ledger = psql(`select provider || '|' || coalesce(actual_micros::text,'null') from usage_ledger where job_id='${job.id}'`);
    expect(ledger).toBe("claude_subscription|0");

    // Settings page shows the runtime and the reported (not estimated) usage window.
    await page.goto("/settings");
    await expect(page.getByText("Claude subscription via Claude Code (default)")).toBeVisible();
    await expect(page.getByText(/Signed-in account: max \(subscription\)/)).toBeVisible();
    await expect(page.getByText(/31% used/)).toBeVisible();
    await page.locator("#claude").screenshot({ path: join(ART, "a31-settings-claude.png") });
    writeFileSync(join(ART, "a31-report.json"), JSON.stringify({ status: ready.runtime.lastCheck, call: c, jobResult: job.result, ledger }, null, 2));
  });

  test("A32: a plan usage limit pauses the job, keeps the project, never falls back to an API key; resume works", async ({ request, page }) => {
    await scenario(request, "max");
    const created = await createProject(request, { templateId: "motion-reel", title: "A32 limit", inputs: { hook: "Hi", headline: "Plan less", brandName: "Tidewave" } });
    const id = created.project.id;
    const v0 = await (await request.get(`/api/projects/${id}`)).json();

    await scenario(request, "max_limit");
    const r = await request.post(`/api/projects/${id}/assistant`, { data: { request: "Slow down scene one", baseRevisionId: v0.revision.id } });
    expect(r.status()).toBe(202);
    const jobId = (await r.json()).job.id;
    const paused = await waitJob(request, jobId, ["paused", "failed", "succeeded"]);
    expect(paused.status).toBe("paused");
    expect(paused.error.code).toBe("usage_limit");
    expect(paused.error.message).toMatch(/usage limit was reached/);
    expect(paused.error.message).toMatch(/not moved to paid API billing/);
    expect(paused.error.recovery).toMatch(/Resume/);
    // Not retried automatically, and nothing else was attempted.
    await new Promise((res) => setTimeout(res, 3000));
    expect((await (await request.get(`/api/jobs/${jobId}`)).json()).job.status).toBe("paused");
    expect(psql(`select count(*) from usage_ledger where job_id='${jobId}'`)).toBe("0");
    const v1 = await (await request.get(`/api/projects/${id}`)).json();
    expect(v1.revision.id).toBe(v0.revision.id);
    const st = await (await request.get("/api/settings/claude")).json();
    expect(st.runtime.lastLimit).toMatchObject({ status: "rejected", rateLimitType: "five_hour" });
    expect(st.runtime.mode).toBe("subscription");

    // The owner resumes after the window resets — from the editor.
    await scenario(request, "max");
    await page.goto(`/projects/${id}`);
    await expect(page.getByText("Claude paused:")).toBeVisible();
    await page.getByRole("button", { name: /Resume or cancel in the Assistant tab/ }).click();
    await page.screenshot({ path: join(ART, "a32-paused.png") });
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    // Resuming re-queues the job; wait for it to leave "paused" and finish.
    const resumed = await waitJob(request, jobId, ["succeeded", "failed"]);
    expect(resumed.status).toBe("succeeded");
    expect(resumed.result.status).toBe("applied");
    expect(psql(`select provider from usage_ledger where job_id='${jobId}'`)).toBe("claude_subscription");

    // A paused job can also be canceled outright.
    await scenario(request, "max_limit");
    const v2 = await (await request.get(`/api/projects/${id}`)).json();
    const r2 = await request.post(`/api/projects/${id}/assistant`, { data: { request: "Again", baseRevisionId: v2.revision.id } });
    const j2 = (await r2.json()).job.id;
    await waitJob(request, j2, ["paused"]);
    expect((await request.post(`/api/jobs/${j2}/cancel`)).status()).toBe(200);
    expect((await (await request.get(`/api/jobs/${j2}`)).json()).job.status).toBe("canceled");
    writeFileSync(join(ART, "a32-report.json"), JSON.stringify({ paused: { status: paused.status, error: paused.error }, resumed: { status: resumed.status, result: resumed.result } }, null, 2));
  });

  test("Claude Code handoff: export a revision, import typed operations with the same guards", async ({ request }) => {
    await scenario(request, "signed_out"); // the fallback path when the integrated runtime is unavailable
    const created = await createProject(request, { templateId: "motion-reel", title: "Handoff", inputs: { hook: "Hi", headline: "Plan less", brandName: "Tidewave" } });
    const id = created.project.id;
    const dl = await request.get(`/api/projects/${id}/handoff`);
    expect(dl.status()).toBe(200);
    expect(dl.headers()["content-disposition"]).toMatch(/attachment; filename="claude-code-handoff-/);
    const bundle = await dl.json();
    expect(bundle).toMatchObject({ format: "claude-video-studio.handoff/1", projectId: id });
    expect(bundle.instructions).toMatch(/operations\.json/);
    expect(bundle.operationSchema.oneOf.length).toBeGreaterThan(10);
    // What Claude Code would write after following the instructions:
    const sceneId = bundle.document.scenes[1].id;
    const ops = { baseRevisionId: bundle.baseRevisionId, ops: [{ op: "setSceneDuration", sceneId, durationFrames: 5 * bundle.document.format.fps }] };
    const imp = await request.post(`/api/projects/${id}/handoff`, { data: ops });
    expect(imp.status(), await imp.text()).toBe(200);
    expect((await imp.json()).changedSceneIds).toEqual([sceneId]);
    // Importing the same file again is stale (the project moved on) → rejected, nothing applied.
    const again = await request.post(`/api/projects/${id}/handoff`, { data: ops });
    expect(again.status()).toBe(409);
    // Locked scenes stay protected.
    const v = await (await request.get(`/api/projects/${id}`)).json();
    await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: v.revision.id, ops: [{ op: "setSceneLock", sceneId, locked: true }] } });
    const v2 = await (await request.get(`/api/projects/${id}`)).json();
    const locked = await request.post(`/api/projects/${id}/handoff`, { data: { baseRevisionId: v2.revision.id, ops: [{ op: "setSceneDuration", sceneId, durationFrames: 4 * bundle.document.format.fps }] } });
    expect(locked.status()).toBe(403);
  });

  test("A33: loopback + origin protection; no subscription secrets in browser, database or logs", async ({ request, playwright }) => {
    await scenario(request, "max");
    const created = await createProject(request, { templateId: "motion-reel", title: "A33 origin", inputs: { hook: "Hi", headline: "Plan less", brandName: "Tidewave" } });
    const id = created.project.id;
    const rev = (await (await request.get(`/api/projects/${id}`)).json()).revision.id;

    // A page on another site cannot submit prompts or edits to the local studio.
    for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, { origin: "null" }]) {
      const x = await request.post(`/api/projects/${id}/assistant`, { data: { request: "exfiltrate", baseRevisionId: rev }, headers });
      expect(x.status(), JSON.stringify(headers)).toBe(403);
      expect((await x.json()).error.code).toBe("cross_origin_request");
    }
    const xs = await request.put("/api/settings/claude", { data: { mode: "api" }, headers: { origin: "http://attacker.localhost:3000" } });
    expect(xs.status()).toBe(403);
    // Same-origin browser requests still work.
    const same = await request.post(`/api/projects/${id}/operations`, { data: { baseRevisionId: rev, ops: [{ op: "setTitle", title: "A33 same origin" }] }, headers: { origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" } });
    expect(same.status()).toBe(200);
    // DNS-rebinding style requests (non-loopback Host) are refused in local mode.
    const ctx = await playwright.request.newContext({ baseURL: "http://127.0.0.1:3000", extraHTTPHeaders: { host: "rebind.example" } });
    const rb = await ctx.get("/api/settings/claude");
    expect(rb.status()).toBe(403);
    await ctx.dispose();
    // The server listens on loopback only.
    const listen = listeners(3000);
    expect(listen).toContain("127.0.0.1");
    expect(listen.filter((a) => a !== "127.0.0.1" && a !== "::1")).toEqual([]);

    // Status responses carry names only; secret-looking override values never leave the server.
    const secrets = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"].map((k) => process.env[k]).filter((v): v is string => !!v && v.length > 6);
    const body = await (await request.get("/api/settings/claude")).text();
    const providers = await (await request.get("/api/settings/providers")).text();
    const dbDump = psql("select coalesce(string_agg(settings::text || coalesce(last_check::text,''), ' '),'') from provider_configs") + psql("select coalesce(string_agg(coalesce(error::text,'') || coalesce(result::text,''), ' '),'') from jobs");
    const logs = readFileSync(join(ROOT, "data", "web.log"), "utf8").slice(-2_000_000) + readFileSync(join(ROOT, "data", "worker.log"), "utf8").slice(-2_000_000);
    for (const s of secrets) {
      expect(body).not.toContain(s);
      expect(providers).not.toContain(s);
      expect(dbDump).not.toContain(s);
      expect(logs).not.toContain(s);
    }
    // No credential material of Claude Code is stored by the studio.
    expect(dbDump).not.toMatch(/oauth|accessToken|refreshToken|sk-ant-/i);
    writeFileSync(join(ART, "a33-report.json"), JSON.stringify({ secretsChecked: secrets.length, listen, overridesReported: JSON.parse(body).runtime.overrides }, null, 2));
  });
});
