/**
 * TEST-ONLY stand-in for a local OmniVoice server (OpenAI-compatible speech API). It returns a
 * synthetic SAMPLE tone whose length follows the text, so the studio's OmniVoice adapter,
 * narration fitting and caching can be tested without the model. Never used by the app unless
 * an OmniVoice server address in Settings points here.
 *
 *   FAKE_OMNIVOICE_PORT=3902 tsx scripts/fake-omnivoice.ts
 *   GET  /v1/audio/voices   POST /v1/audio/speech   GET /__requests (recorded request bodies)
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
