/**
 * TEST-ONLY stand-in for a local OmniVoice server (OpenAI-compatible speech API). It returns a
 * synthetic SAMPLE tone whose length follows the text, so the studio's OmniVoice adapter,
 * narration fitting and caching can be tested without the model. Never used by the app unless
 * an OmniVoice server address in Settings points here.
 *
 *   FAKE_OMNIVOICE_PORT=3902 tsx scripts/fake-omnivoice.ts
 *   GET  /v1/audio/voices   POST /v1/audio/speech   GET /__requests (recorded request bodies)
 * Also a TEST-ONLY ElevenLabs stand-in under /el (ELEVENLABS_BASE_URL=http://127.0.0.1:3902/el):
 *   GET /el/v1/voices, POST /el/v1/text-to-speech/{voice_id} (key "el-test-key"; voice "quotaVoice01" → quota error)
 *   POST /el/v1/music — MP3 of music_length_ms (a chord with a pulse); prompt "QUOTA" → quota error
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.FAKE_OMNIVOICE_PORT ?? 3902);
const dir = mkdtempSync(join(tmpdir(), "fake-omnivoice-"));
const VOICES = [{ id: "narrator_warm", name: "Warm narrator", language: "en" }, { id: "my_clone", name: "My cloned voice", language: "en" }];
const requests: unknown[] = [];
let n = 0;

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    if (url.pathname === "/__requests") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(requests));
    }
    if (url.pathname.startsWith("/el/v1/")) {
      const key = req.headers["xi-api-key"];
      if (key !== "el-test-key") {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } }));
      }
      if (url.pathname === "/el/v1/voices") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ voices: [{ voice_id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", category: "premade", labels: { accent: "american" } }, { voice_id: "krisClone00000000001", name: "Kris", category: "cloned", labels: {} }, { voice_id: "quotaVoice01", name: "Quota Test", category: "premade" }] }));
      }
      if (url.pathname === "/el/v1/music" && req.method === "POST") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const body = JSON.parse(raw || "{}") as { prompt?: string; music_length_ms?: number; force_instrumental?: boolean; model_id?: string };
          requests.push({ elevenlabsMusic: true, query: url.search, ...body });
          if (/QUOTA/.test(body.prompt ?? "")) {
            res.writeHead(401, { "content-type": "application/json" });
            return res.end(JSON.stringify({ detail: { status: "quota_exceeded", message: "This request exceeds your quota." } }));
          }
          const sec = Math.max(3, Math.min(600, (body.music_length_ms ?? 30000) / 1000));
          const out = join(dir, `music${++n}.mp3`);
          execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=f=220:d=${sec}`, "-f", "lavfi", "-i", `sine=f=277:d=${sec}`, "-f", "lavfi", "-i", `sine=f=330:d=${sec}`, "-filter_complex", "amix=inputs=3,volume='0.25+0.15*sin(2*PI*2*t)':eval=frame", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", out]);
          const buf = readFileSync(out);
          res.writeHead(200, { "content-type": "audio/mpeg", "content-length": buf.length });
          res.end(buf);
        });
        return;
      }
      const m = /^\/el\/v1\/text-to-speech\/([A-Za-z0-9]+)$/.exec(url.pathname);
      if (m && req.method === "POST") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const body = JSON.parse(raw || "{}") as { text?: string; model_id?: string; voice_settings?: { speed?: number } };
          requests.push({ elevenlabs: true, voice: m[1], ...body });
          if (m[1] === "quotaVoice01") {
            res.writeHead(401, { "content-type": "application/json" });
            return res.end(JSON.stringify({ detail: { status: "quota_exceeded", message: "This request exceeds your quota." } }));
          }
          const sec = Math.max(1, Math.min(20, (body.text ?? "").length * 0.055 / (body.voice_settings?.speed ?? 1)));
          const out = join(dir, `el${++n}.mp3`);
          execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=f=${300 + (n % 4) * 50}:d=${sec.toFixed(2)}`, "-af", "volume=0.3", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", out]);
          const buf = readFileSync(out);
          res.writeHead(200, { "content-type": "audio/mpeg", "content-length": buf.length });
          res.end(buf);
        });
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ detail: { status: "voice_not_found" } }));
    }
    if (url.pathname === "/v1/audio/voices" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ voices: VOICES }));
    }
    if (url.pathname === "/v1/audio/speech" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body: { input?: string; voice?: string; response_format?: string; speed?: number; instructions?: string; model?: string };
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400);
          return res.end("bad json");
        }
        requests.push(body);
        const known = VOICES.some((v) => v.id === body.voice) || !!body.instructions;
        if (!body.input || !known) {
          res.writeHead(404, { "content-type": "application/json" });
          return res.end(JSON.stringify({ detail: `voice not found: ${body.voice}` }));
        }
        const sec = Math.max(1, Math.min(20, body.input.length * 0.055 / (body.speed ?? 1)));
        const out = join(dir, `s${++n}.wav`);
        execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=f=${180 + (n % 5) * 40}:d=${sec.toFixed(2)}`, "-af", "volume=0.3", "-ar", "24000", "-ac", "1", out]);
        const buf = readFileSync(out);
        res.writeHead(200, { "content-type": "audio/wav", "content-length": buf.length });
        res.end(buf);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(PORT, "127.0.0.1", () => console.log(`fake OmniVoice on http://127.0.0.1:${PORT}`));
