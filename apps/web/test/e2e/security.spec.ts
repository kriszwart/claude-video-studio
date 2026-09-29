/**
 * A14 (cross-workspace access) and A15 (unsafe URL / upload / composition input) against a
 * production build in password mode (E2E_PROD_URL, default http://127.0.0.1:3100), plus the
 * local-mode loopback guard on the dev server.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, request as pwRequest, test, type APIRequestContext } from "@playwright/test";
import { FIX } from "./helpers";

const PROD = process.env.E2E_PROD_URL ?? "http://127.0.0.1:3100";
const DEV = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";

async function login(email: string, password: string) {
  const ctx = await pwRequest.newContext({ baseURL: PROD });
  const r = await ctx.post("/api/auth/login", { data: { email, password } });
  expect(r.status(), await r.text()).toBe(200);
  return ctx;
}
async function upload(ctx: APIRequestContext, name: string, mime: string, bytes: Buffer) {
  const a = await ctx.post("/api/assets/uploads", { data: { filename: name, mime, bytes: bytes.length, rightsAcknowledged: true } });
  if (a.status() !== 201) return { status: a.status(), body: await a.json() };
  const j = await a.json();
  expect((await ctx.put(j.uploadUrl, { data: bytes, headers: { "content-type": "application/octet-stream" } })).status()).toBe(200);
  const fin = await (await ctx.post(`/api/assets/${j.asset.id}/finalize`)).json();
  for (let i = 0; i < 120; i++) {
    const job = (await (await ctx.get(`/api/jobs/${fin.job.id}`)).json()).job;
    if (["succeeded", "failed"].includes(job.status)) return { status: 201, asset: j.asset, job };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("ingest timeout");
}
async function waitJob(ctx: APIRequestContext, id: string) {
  for (let i = 0; i < 240; i++) {
    const job = (await (await ctx.get(`/api/jobs/${id}`)).json()).job;
    if (["succeeded", "failed", "canceled"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("job timeout");
}

test.describe.serial("security (A14, A15)", () => {
  let alice: APIRequestContext;
  let bob: APIRequestContext;
  let aliceProject = "";
  let aliceAsset = "";
  let aliceJob = "";
  let aliceTitle = "";

  test.beforeAll(async () => {
    alice = await login("alice@example.test", "alice-password-123");
    bob = await login("bob@example.test", "bob-password-12345");
  });

  test("unauthenticated requests are refused; setup cannot be re-claimed", async () => {
    const anon = await pwRequest.newContext({ baseURL: PROD });
    for (const path of ["/api/projects", "/api/assets", "/api/templates", "/api/settings/providers"]) expect((await anon.get(path)).status(), path).toBe(401);
    expect((await anon.post("/api/projects", { data: {} })).status()).toBe(401);
    const setup = await anon.post("/api/auth/setup", { data: { setupToken: "wrong-token", email: "x@example.test", password: "0123456789ab" } });
    expect([403, 409]).toContain(setup.status());
    const page = await anon.get("/projects", { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(page.status());
    const bad = await anon.post("/api/auth/login", { data: { email: "alice@example.test", password: "wrong-password" } });
    expect(bad.status()).toBe(401);
  });

  test("A14: another workspace can't see or touch Alice's projects, assets, jobs or files", async () => {
    const up = await upload(alice, "alice-logo.png", "image/png", readFileSync(join(FIX, "logo-tidewave.png")));
    expect(up.job.status).toBe("succeeded");
    aliceAsset = String(up.job.result.assetId);
    aliceTitle = `Alice secret launch ${Date.now()}`;
    const created = await alice.post("/api/projects", { data: { templateId: "motion-reel", title: aliceTitle, inputs: { hook: "Hi", headline: "Secret headline", brandName: "Tidewave", logo: aliceAsset } } });
    expect(created.status(), await created.text()).toBe(201);
    aliceProject = (await created.json()).project.id;
    const kf = await (await alice.post(`/api/projects/${aliceProject}/keyframes`, { data: {} })).json();
    aliceJob = kf.job.id;
    const assetView = await (await alice.get(`/api/assets/${aliceAsset}`)).json();
    const signedUrl: string = assetView.asset.url ?? assetView.asset.thumbUrl;
    expect((await alice.get(signedUrl)).status()).toBe(200);

    const denied = async (r: Awaited<ReturnType<APIRequestContext["get"]>>) => {
      expect(r.status()).toBe(404);
      const text = await r.text();
      expect(text).not.toContain(aliceTitle);
      expect(text).not.toContain("Secret headline");
      expect(text).not.toContain("alice-logo");
    };
    await denied(await bob.get(`/api/projects/${aliceProject}`));
    await denied(await bob.get(`/api/projects/${aliceProject}/revisions`));
    await denied(await bob.get(`/api/projects/${aliceProject}/events`));
    await denied(await bob.post(`/api/projects/${aliceProject}/operations`, { data: { baseRevisionId: "rev_x", ops: [{ op: "setTitle", title: "pwned" }] } }));
    await denied(await bob.post(`/api/projects/${aliceProject}/preview`, { data: {} }));
    await denied(await bob.post(`/api/projects/${aliceProject}/duplicate`, { data: {} }));
    await denied(await bob.get(`/api/assets/${aliceAsset}`));
    await denied(await bob.get(`/api/jobs/${aliceJob}`));
    await denied(await bob.post(`/api/jobs/${aliceJob}/cancel`));
    // Bob's lists never include Alice's data.
    expect(JSON.stringify(await (await bob.get("/api/projects")).json())).not.toContain(aliceProject);
    expect(JSON.stringify(await (await bob.get("/api/assets")).json())).not.toContain(aliceAsset);
    // Alice's signed file URL is useless in Bob's session (signature is workspace-bound).
    expect([403, 404]).toContain((await bob.get(signedUrl)).status());
    // Tampering with the asset id breaks the signature.
    expect((await alice.get(signedUrl.replace(aliceAsset, aliceAsset.slice(0, -1) + (aliceAsset.endsWith("a") ? "b" : "a")))).status()).toBe(403);
    // Bob can't smuggle Alice's asset into his own project, at creation or by edit.
    const smuggle = await bob.post("/api/projects", { data: { templateId: "motion-reel", title: "Bob", inputs: { hook: "Hi", headline: "x", brandName: "B", logo: aliceAsset } } });
    expect(smuggle.status()).toBe(422);
    expect(await smuggle.text()).not.toContain("alice-logo");
    const bobProj = await (await bob.post("/api/projects", { data: { templateId: "motion-reel", title: "Bob", inputs: { hook: "Hi", headline: "x", brandName: "B" } } })).json();
    const scene = bobProj.doc.scenes[0];
    const edit = await bob.post(`/api/projects/${bobProj.project.id}/operations`, { data: { baseRevisionId: bobProj.revision.id, ops: [{ op: "setSceneBackground", sceneId: scene.id, background: { type: "asset", assetId: aliceAsset, dim: 0.3, blur: 0 } }] } });
    expect(edit.status()).toBe(422);
    // Alice's project is unchanged.
    expect((await (await alice.get(`/api/projects/${aliceProject}`)).json()).doc.title).toBe(aliceTitle);

    // Collections, quotes, profiles and quality reports are workspace-scoped too.
    const col = (await (await alice.post("/api/collections", { data: { name: "Alice secret event" } })).json()).collection.id;
    const prof = (await (await alice.post("/api/profiles", { data: { name: "Alice secret style", preset: "calm-technical" } })).json()).profile.id;
    for (const [method, url, data] of [
      ["get", `/api/collections/${col}`, undefined],
      ["get", `/api/collections/${col}/search?q=secret`, undefined],
      ["post", `/api/collections/${col}/index`, { all: true }],
      ["post", `/api/collections/${col}/uploads`, { filename: "x.mp4", mime: "video/mp4", bytes: 10, rightsAcknowledged: true }],
      ["post", `/api/collections/${col}/sizzle`, { title: "x", inputs: { eventName: "x" }, quotes: [{ transcriptId: "trn_x", segmentIds: ["a"] }] }],
      ["get", `/api/profiles/${prof}`, undefined],
      ["post", `/api/profiles/${prof}/propose`, { feedback: "larger text", baseVersion: 1 }],
      ["post", `/api/profiles/analyze`, { assetId: aliceAsset }],
      ["get", `/api/projects/${aliceProject}/quality`, undefined],
      ["get", `/api/projects/${aliceProject}/asset-requests`, undefined],
    ] as const) {
      const r = method === "get" ? await bob.get(url) : await bob.post(url, { data });
      expect(r.status(), `${method} ${url}`).toBe(404);
      expect(await r.text()).not.toContain("Alice secret");
    }
    const bobCollections = await (await bob.get("/api/collections")).json();
    expect(JSON.stringify(bobCollections)).not.toContain("Alice secret");
    const bobProfiles = await (await bob.get("/api/profiles")).json();
    expect(JSON.stringify(bobProfiles.profiles)).not.toContain("Alice secret");
  });

  test("A15: private/metadata URLs, disguised and hostile uploads are rejected", async () => {
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:5432/", "http://[::ffff:127.0.0.1]/x.png", "http://2130706433/x.png"]) {
      const r = await alice.post("/api/assets/import", { data: { url, rightsAcknowledged: true } });
      expect(r.status(), url).toBe(202);
      const job = await waitJob(alice, (await r.json()).job.id);
      expect(job.status, url).toBe("failed");
      expect(["blocked_address", "blocked_port"], url).toContain(job.error.code);
      expect(JSON.stringify(job.error)).not.toMatch(/ECONNREFUSED|stack|at \//);
    }
    const fileUrl = await alice.post("/api/assets/import", { data: { url: "file:///etc/passwd", rightsAcknowledged: true } });
    if (fileUrl.status() !== 400) {
      expect(fileUrl.status()).toBe(202);
      expect((await waitJob(alice, (await fileUrl.json()).job.id)).error.code).toBe("invalid_url");
    }
    // HTML disguised as a PNG.
    const fake = await upload(alice, "photo.png", "image/png", Buffer.from("<html><script>alert(1)</script></html>"));
    expect(fake.job.status).toBe("failed");
    // Path traversal in the file name is neutralised.
    const trav = await upload(alice, "../../../../etc/passwd.png", "image/png", readFileSync(join(FIX, "logo-lumen.png")));
    const tv = await (await alice.get(`/api/assets/${trav.job.result.assetId}`)).json();
    expect(tv.asset.name).not.toContain("/");
    expect(tv.asset.name).not.toContain("..");
    // Unsupported archive type and oversize declarations are refused up front.
    expect((await upload(alice, "bundle.zip", "application/zip", Buffer.from("PK\u0003\u0004"))).status).toBe(415);
    const big = await alice.post("/api/assets/uploads", { data: { filename: "huge.mp4", mime: "video/mp4", bytes: 50 * 1024 * 1024 * 1024, rightsAcknowledged: true } });
    expect(big.status()).toBe(413);
    // An SVG with script and external references is rasterised offline with scripts off,
    // and the original is only ever served as an attachment under a sandbox CSP.
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><script>fetch('http://169.254.169.254/')</script><image href="http://169.254.169.254/x.png" width="10" height="10"/><rect width="200" height="100" fill="#f59e0b"/></svg>`);
    const s = await upload(alice, "evil.svg", "image/svg+xml", svg);
    expect(s.job.status).toBe("succeeded");
    const sv = await (await alice.get(`/api/assets/${s.job.result.assetId}`)).json();
    const orig = await alice.get(sv.asset.url);
    expect(orig.headers()["content-disposition"]).toMatch(/^attachment/);
    expect(orig.headers()["content-security-policy"]).toContain("sandbox");
  });

  test("local mode refuses non-loopback hosts", async () => {
    const dev = await pwRequest.newContext({ baseURL: DEV });
    const r = await dev.get("/api/projects", { headers: { host: "studio.example.com" } });
    expect(r.status()).toBe(403);
    const f = await dev.get("/api/projects", { headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(f.status()).toBe(403);
  });
});
