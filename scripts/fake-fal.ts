/**
 * TEST-ONLY fake of fal's queue API, for deterministic tests of the real adapter, webhook
 * verification, budgets and recovery. It is not a provider and is never used by the app
 * unless FAL_QUEUE_BASE_URL points at it. Output media is a synthetic ffmpeg test pattern.
 *
 *   FAKE_FAL_PORT=3910 tsx scripts/fake-fal.ts
 * Behaviour hooks (in the prompt): "[fail]" → the request ends with ERROR.
 * Control: POST /__control {"duplicateWebhooks":true,"staleAfter":true,"delayMs":1500}
 * Stats:   GET /__stats
 *
 * Also a TEST-ONLY OpenRouter stand-in (OPENROUTER_BASE_URL=http://127.0.0.1:3910/or/api/v1):
 *   POST /or/api/v1/chat/completions — key "or-test-key"; returns one PNG as a data: URL in
 *   choices[0].message.images and usage.cost 0.039. Prompt "CREDITS" → 402; model "test/text-only" → no image.
 *   GET /__or → the requests received (model, modalities, image_config, reference count).
 *
 * Also a TEST-ONLY Jev (TypeSafe System One) stand-in (JEV_BASE_URL=http://127.0.0.1:3910/jev):
 *   POST /jev/v1/systemone — key "jev-test-key"; answers each question deterministically from
 *   keywords in state.request (vertical/tiktok → 9:16, "15 second" → 15, lesson → professor…).
 *   Request "SLOW" → answers after 5 s (the app gives up); GET /__jev → requests received.
 *
 * Also a TEST-ONLY Lanternist MCP stand-in (Streamable HTTP) at POST /lantern/mcp, token
 * "lantern-test-key": initialize (JSON reply + Mcp-Session-Id), tools/call (SSE reply) for
 * create_project, get_project, list_projects, make_picture, create_review_link.
 * GET /__lantern → calls and films received.
 */
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.FAKE_FAL_PORT ?? 3910);
const DIR = join(tmpdir(), "fake-fal");
mkdirSync(DIR, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwk = publicKey.export({ format: "jwk" }) as { x: string };

type Req = { id: string; endpoint: string; input: Record<string, unknown>; webhook?: string; state: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED"; error?: string; canceled: boolean; payload?: unknown };
const reqs = new Map<string, Req>();
const control = { duplicateWebhooks: false, staleAfter: false, delayMs: 1500, webhooks: true };
const stats = { submits: 0, statusCalls: 0, resultCalls: 0, cancels: 0, webhooksSent: 0, authFailures: 0 };
let n = 0;
const jevRequests: unknown[] = [];
const lantern = { calls: [] as { name: string; args: unknown }[], films: new Map<string, { id: string; title: unknown; aspect_ratio: unknown; style: unknown; shots: { id: string; scene_number: number; start_time: number; end_time: number; description: string; voiceover_script: string | null; image_prompt: string | null; generated_image: string | null }[]; reviewUrl: string | null }>() };
const orRequests: Record<string, unknown>[] = [];

function media(id: string, kind: "video" | "image") {
  const file = join(DIR, `${id}.${kind === "video" ? "mp4" : "png"}`);
  if (!existsSync(file)) {
    // Distinct bytes per request (hue from a hash, id in the metadata): content-addressed asset
    // storage must never see two different requests as the same file.
    const seed = parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16);
    if (kind === "video") execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=4,hue=h=${seed % 360}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-metadata", `comment=fake-fal ${id}`, "-movflags", "+faststart", file]);
    else execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=768x768:rate=1:duration=1,hue=h=${seed % 360},drawbox=x=${seed % 700}:y=${(seed >> 10) % 700}:w=8:h=8:color=white:t=fill`, "-frames:v", "1", file]);
  }
  return file;
}

async function sendWebhook(r: Req, status: "OK" | "ERROR", payload: unknown, error?: string) {
  if (!r.webhook || !control.webhooks) return;
  const body = Buffer.from(JSON.stringify({ status, request_id: r.id, payload, ...(error ? { error } : {}) }));
  const ts = String(Math.floor(Date.now() / 1000));
  const msg = Buffer.from([r.id, "user_test", ts, createHash("sha256").update(body).digest("hex")].join("\n"));
  const headers = { "content-type": "application/json", "x-fal-webhook-request-id": r.id, "x-fal-webhook-user-id": "user_test", "x-fal-webhook-timestamp": ts, "x-fal-webhook-signature": sign(null, msg, privateKey).toString("hex") };
  stats.webhooksSent++;
  await fetch(r.webhook, { method: "POST", headers, body }).catch(() => undefined);
}

function finish(r: Req) {
  const kind = /image/.test(r.endpoint) ? "image" : "video";
  const fail = String(r.input.prompt ?? "").includes("[fail]");
  r.state = "COMPLETED";
  if (fail) {
    r.error = "Simulated provider failure";
    void sendWebhook(r, "ERROR", null, r.error);
    return;
  }
  const url = `http://127.0.0.1:${PORT}/files/${r.id}.${kind === "video" ? "mp4" : "png"}`;
  r.payload = kind === "video" ? { video: { url, content_type: "video/mp4" } } : { images: [{ url, content_type: "image/png", width: 768, height: 768 }] };
  void (async () => {
    await sendWebhook(r, "OK", r.payload);
    if (control.duplicateWebhooks) await sendWebhook(r, "OK", r.payload);
    // A stale, out-of-order failure event for the same request must not undo the result.
    if (control.staleAfter) await sendWebhook(r, "ERROR", null, "stale event");
  })();
}

const json = (res: http.ServerResponse, code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));

http
  .createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    // TEST fixture web page for screenshot capture: one local image plus attempts to reach
    // internal addresses, which the capture worker must refuse.
    if (u.pathname === "/__page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><html><head><title>Fixture launch page</title><style>body{margin:0;font:600 40px sans-serif;background:#0f172a;color:#fff}main{padding:60px}h1{color:#fbbf24}</style></head><body><main><h1>Tidewave — sample page</h1><p>SAMPLE fixture served by the test-only fake server.</p><img src="/__img.png" width="320" height="180" alt=""><img src="http://169.254.169.254/latest/meta-data/" alt=""><img src="http://127.0.0.1:5432/" alt=""><script>fetch("http://10.0.0.1/internal").catch(()=>{});</script></main></body></html>`);
    }
    if (u.pathname === "/__img.png") {
      const f = join(tmpdir(), "fake-fal-page.png");
      if (!existsSync(f)) execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=1:duration=1", "-frames:v", "1", f]);
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(readFileSync(f));
    }
    if (u.pathname === "/__or") return json(res, 200, orRequests);
    if (u.pathname === "/__jev") return json(res, 200, jevRequests);
    if (u.pathname === "/__lantern") return json(res, 200, { calls: lantern.calls, films: [...lantern.films.values()] });
    if (u.pathname === "/lantern/mcp" && req.method === "POST") {
      if (req.headers.authorization !== "Bearer lantern-test-key") return json(res, 401, { error: "unauthorized" });
      const m = JSON.parse(bodyText || "{}") as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (m.method === "notifications/initialized") {
        res.writeHead(202);
        return res.end();
      }
      if (m.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "lantern-session-1" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-lanternist", version: "0" } } }));
      }
      if (req.headers["mcp-session-id"] !== "lantern-session-1") return json(res, 400, { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "no session" } });
      const name = m.params?.name ?? "";
      const a = m.params?.arguments ?? {};
      lantern.calls.push({ name, args: a });
      let out: unknown;
      let isError = false;
      if (name === "create_project") {
        const id = `film-${lantern.films.size + 1}`;
        let t = 0;
        const shots = ((a.shots as { description: string; duration?: number; narration?: string; image_prompt?: string }[]) ?? []).map((sh, i) => {
          const d = sh.duration ?? 5;
          const row = { id: `${id}-shot-${i + 1}`, scene_number: i + 1, start_time: t, end_time: t + d, description: sh.description, voiceover_script: sh.narration ?? null, image_prompt: sh.image_prompt ?? null, generated_image: null as string | null };
          t += d;
          return row;
        });
        lantern.films.set(id, { id, title: a.title, aspect_ratio: a.aspect_ratio, style: a.style, shots, reviewUrl: null as string | null });
        out = { project_id: id, shots: shots.length, editor_url: `https://lanternist.example/editor?project=${id}` };
      } else if (name === "get_project") {
        const f = lantern.films.get(String(a.project_id));
        out = f ?? null;
        isError = !f;
      } else if (name === "list_projects") out = { projects: [...lantern.films.values()].map((f) => ({ id: f.id, title: f.title })) };
      else if (name === "make_picture") {
        const shot = [...lantern.films.values()].flatMap((f) => f.shots).find((x) => x.id === a.scene_id);
        if (shot) shot.generated_image = `https://lanternist.example/img/${shot.id}.png`;
        out = shot ? { ok: true } : null;
        isError = !shot;
      } else if (name === "create_review_link") {
        const f = lantern.films.get(String(a.project_id));
        if (f) f.reviewUrl = `https://lanternist.example/v/${f.id}`;
        out = f ? { review_url: f.reviewUrl } : null;
        isError = !f;
      } else {
        isError = true;
        out = `unknown tool ${name}`;
      }
      const result = { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }], isError };
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`);
    }
    if (u.pathname === "/jev/v1/systemone" && req.method === "POST") {
      if (req.headers.authorization !== "Bearer jev-test-key") return json(res, 401, { error: "invalid api key" });
      const b = JSON.parse(bodyText || "{}") as { model?: string; state?: { request?: string } | string; questions?: Record<string, { type: string; criteria?: Record<string, string> | string[] }> };
      const text = (typeof b.state === "string" ? b.state : (b.state?.request ?? "")).toLowerCase();
      jevRequests.push({ model: b.model, questions: Object.keys(b.questions ?? {}), state: b.state });
      if (text.includes("slow")) await new Promise((r) => setTimeout(r, 5000));
      const pick = (q: { criteria?: Record<string, string> | string[] }, rules: [RegExp, string][], fallback?: string) => {
        const keys = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria ?? {});
        const hit = rules.find(([re, k]) => re.test(text) && keys.includes(k))?.[1];
        const choice = hit ?? (fallback && keys.includes(fallback) ? fallback : keys[0]!);
        const probabilities = Object.fromEntries(keys.map((k) => [k, k === choice ? (hit ? 0.86 : 0.4) : (hit ? 0.14 : 0.6) / Math.max(1, keys.length - 1)]));
        return { type: "choice", choice, probabilities, confidence: hit ? 0.8 : 0.3 };
      };
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(b.questions ?? {})) {
        if (q.type === "noul") answers[id] = { type: "noul", probability: /no voice|without voice|no narration|music only/.test(text) ? 0.1 : /narrat|voice|explain|lesson|story/.test(text) ? 0.9 : 0.5 };
        else if (q.type === "score") answers[id] = { type: "score", score: 1, confidence: 0.5 };
        else if (id === "template") answers[id] = pick(q, [[/mascot|robot|character/, "mascot-story"], [/lesson|course|teach/, "course-lesson"], [/music video|song/, "music-video"], [/anime/, "anime-opening"], [/launch|product|app/, "product-launch"], [/tiktok|reel|short/, "vertical-short"]]);
        else if (id === "aspect") answers[id] = pick(q, [[/vertical|tiktok|reels?|shorts?|stories/, "9:16"], [/square|instagram post|linkedin/, "1:1"], [/youtube|website|landscape/, "16:9"]], "16:9");
        else if (id === "length") answers[id] = pick(q, [[/15[- ]second/, "15"], [/30[- ]second|half a minute/, "30"], [/45[- ]second/, "45"], [/one minute|60[- ]second|a minute/, "60"], [/90[- ]second/, "90"], [/two minute|2 minute/, "120"]]);
        else if (id === "style") answers[id] = pick(q, [[/lesson|lecture|course|teach/, "professor"], [/documentary/, "documentary"], [/energetic|punchy|hype|tiktok/, "energetic"], [/friendly|casual/, "conversational"], [/calm|clear|simple/, "plain"]]);
        else answers[id] = pick(q, []);
      }
      return json(res, 200, { model: "jev-1.13.0-test", answers, usage: { input_tokens: Math.ceil(text.length / 4), output_tokens: 8 } });
    }
    if (u.pathname === "/or/api/v1/chat/completions" && req.method === "POST") {
      if (req.headers.authorization !== "Bearer or-test-key") return json(res, 401, { error: { code: 401, message: "No auth credentials found" } });
      const b = JSON.parse(bodyText || "{}") as { model?: string; modalities?: string[]; image_config?: { aspect_ratio?: string }; usage?: { include?: boolean }; messages?: { content?: { type: string; text?: string; image_url?: { url: string } }[] }[] };
      const parts = b.messages?.[0]?.content ?? [];
      const prompt = parts.find((p) => p.type === "text")?.text ?? "";
      orRequests.push({ model: b.model, modalities: b.modalities, imageConfig: b.image_config, usage: b.usage, references: parts.filter((p) => p.type === "image_url" && p.image_url?.url.startsWith("data:image/")).length, prompt });
      if (/CREDITS/.test(prompt)) return json(res, 402, { error: { code: 402, message: "Insufficient credits" } });
      if (b.model === "test/text-only") return json(res, 200, { id: `gen-${++n}`, model: b.model, choices: [{ message: { role: "assistant", content: "I can only write text." } }], usage: { cost: 0.001 } });
      const [w, h] = b.image_config?.aspect_ratio === "9:16" ? [576, 1024] : b.image_config?.aspect_ratio === "1:1" ? [1024, 1024] : [1024, 576];
      const f = join(DIR, `or-${++n}.png`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=1:duration=1`, "-frames:v", "1", f]);
      return json(res, 200, { id: `gen-${n}`, model: b.model, choices: [{ message: { role: "assistant", content: "Here is the image.", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${readFileSync(f).toString("base64")}` } }] } }], usage: { prompt_tokens: 100, completion_tokens: 1290, cost: 0.039 } });
    }
    if (u.pathname === "/.well-known/jwks.json") return json(res, 200, { keys: [{ kty: "OKP", crv: "Ed25519", x: jwk.x, kid: "test" }] });
    if (u.pathname === "/__stats") return json(res, 200, { ...stats, requests: [...reqs.values()].map((r) => ({ id: r.id, endpoint: r.endpoint, state: r.state, canceled: r.canceled, error: r.error ?? null, hasImageUrl: typeof r.input.image_url === "string" && String(r.input.image_url).startsWith("data:image/") })) });
    if (u.pathname === "/__control") {
      Object.assign(control, JSON.parse(bodyText || "{}"));
      return json(res, 200, control);
    }
    if (u.pathname.startsWith("/files/")) {
      const m = /^\/files\/(req_\d+)\.(mp4|png)$/.exec(u.pathname);
      if (!m) return json(res, 404, {});
      const f = media(m[1]!, m[2] === "mp4" ? "video" : "image");
      return res.writeHead(200, { "content-type": m[2] === "mp4" ? "video/mp4" : "image/png" }).end(readFileSync(f));
    }
    if (req.headers.authorization !== "Key test-fal-key-123") {
      stats.authFailures++;
      return json(res, 401, { detail: "Unauthorized" });
    }
    const rm = /^\/([^/]+\/[^/]+)\/requests\/([^/]+)(\/status|\/cancel)?$/.exec(u.pathname);
    if (rm) {
      const r = reqs.get(rm[2]!);
      if (!r) return json(res, 404, { detail: "Request not found" });
      if (rm[3] === "/status") {
        stats.statusCalls++;
        return json(res, 200, { status: r.state, request_id: r.id, ...(r.error ? { error: r.error } : {}) });
      }
      if (rm[3] === "/cancel") {
        stats.cancels++;
        r.canceled = true;
        return json(res, 200, { status: r.state === "COMPLETED" ? "ALREADY_COMPLETED" : "CANCELLATION_REQUESTED" });
      }
      stats.resultCalls++;
      if (r.state !== "COMPLETED") return json(res, 400, { detail: "Request is still in progress" });
      return r.error ? json(res, 422, { detail: r.error }) : json(res, 200, r.payload);
    }
    if (req.method === "POST") {
      stats.submits++;
      const id = `req_${++n}`;
      const r: Req = { id, endpoint: u.pathname.slice(1), input: JSON.parse(bodyText || "{}"), webhook: u.searchParams.get("fal_webhook") ?? undefined, state: "IN_QUEUE", canceled: false };
      reqs.set(id, r);
      setTimeout(() => (r.state = "IN_PROGRESS"), control.delayMs / 3);
      setTimeout(() => finish(r), control.delayMs);
      return json(res, 200, { request_id: id, status: "IN_QUEUE", status_url: `http://127.0.0.1:${PORT}/${r.endpoint}/requests/${id}/status`, response_url: `http://127.0.0.1:${PORT}/${r.endpoint}/requests/${id}` });
    }
    json(res, 404, { detail: "not found" });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`fake fal (TEST ONLY) on :${PORT}`));
