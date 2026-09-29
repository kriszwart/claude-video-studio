/**
 * Large-library collection benchmark (FR-16). Generates N synthetic recordings (SAMPLE: test
 * pattern video + tone/noise audio, with generated .srt transcripts of pseudo-sentences), then
 * against a running server + worker: creates a collection, uploads everything through the
 * resumable upload API, waits for ingest, indexes all items, and runs search queries.
 * Records wall-clock per phase, bytes, source duration, search latency and peak RSS of the
 * worker/web/postgres processes. Usage:
 *   BENCH_FILES=120 BENCH_SECONDS=120 npx tsx scripts/bench-collection.ts
 * Writes artifacts/bench/collection-<files>.json. Numbers are for this machine only.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";

const BASE = process.env.BENCH_BASE_URL ?? "http://127.0.0.1:3000";
const N = Number(process.env.BENCH_FILES ?? 120);
const SEC = Number(process.env.BENCH_SECONDS ?? 120);
const CONC = Number(process.env.BENCH_UPLOAD_CONCURRENCY ?? 4);
const dir = `/tmp/vs-bench-${N}x${SEC}`;
const out = join(import.meta.dirname, "..", "artifacts", "bench");
mkdirSync(dir, { recursive: true });
mkdirSync(out, { recursive: true });

const WORDS = "team build release migration tracing workshop community learned faster outcome insight reaction ticket register welcome keynote session hallway speaker product design data model cache latency deploy review feedback customers growth budget roadmap metrics dashboards incidents weekends coffee lisbon harbor summit".split(" ");
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const sentence = () => {
  const n = 6 + Math.floor(rnd() * 8);
  const w = Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]!);
  return w.join(" ").replace(/^./, (c) => c.toUpperCase()) + ".";
};
const stamp = (s: number) => {
  const ms = Math.round(s * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};

// 1) Generate recordings (cached between runs).
const tGen = Date.now();
for (let i = 0; i < N; i++) {
  const name = `rec-${String(i).padStart(4, "0")}`;
  const mp4 = join(dir, `${name}.mp4`);
  if (!existsSync(mp4)) {
    // Unique content per recording (otherwise hash-based reuse would, correctly, dedupe them).
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=320x180:r=15:d=${SEC},hue=h=${(i * 37) % 360},drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='SAMPLE rec ${i}':x=10:y=10:fontsize=18:fontcolor=white`, "-f", "lavfi", "-i", `sine=f=${180 + i * 3}:d=${SEC},volume=0.2`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "38", "-g", "150", "-c:a", "aac", "-b:a", "32k", "-shortest", mp4]);
    seed = 1000 + i;
    let t = 0.5;
    const cues: string[] = [];
    let k = 1;
    while (t < SEC - 3) {
      const d = 2 + rnd() * 3;
      cues.push(`${k++}\n${stamp(t)} --> ${stamp(t + d)}\n${sentence()}\n`);
      t += d + 0.4 + rnd();
    }
    writeFileSync(join(dir, `${name}.srt`), cues.join("\n"));
  }
}
const genMs = Date.now() - tGen;
const files = readdirSync(dir).filter((f) => /\.(mp4|srt)$/.test(f)).sort();
const totalBytes = files.reduce((a, f) => a + statSync(join(dir, f)).size, 0);

// Peak RSS sampling for worker / web / postgres (Linux /proc).
const peaks: Record<string, number> = { worker: 0, web: 0, postgres: 0 };
const sample = () => {
  try {
    const ps = execFileSync("ps", ["-eo", "rss,args"]).toString().split("\n");
    const sum = (re: RegExp) => ps.filter((l) => re.test(l)).reduce((a, l) => a + Number(l.trim().split(/\s+/)[0] ?? 0), 0) * 1024;
    peaks.worker = Math.max(peaks.worker!, sum(/apps\/worker\/src\/index\.ts|headless_shell|chrome-linux/));
    peaks.web = Math.max(peaks.web!, sum(/next-server|next dev/));
    peaks.postgres = Math.max(peaks.postgres!, sum(/postgres/));
  } catch {
    /* ignore */
  }
};
const sampler = setInterval(sample, 1000);

async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const r = await fetch(BASE + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}
type View = { items: { id: string; sourceName: string; status: string }[]; totals: { files: number; bytes: number; durationSec: number; byStatus: Record<string, number> } };
async function until(id: string, ok: (v: View) => boolean, what: string) {
  for (;;) {
    const v = await api<View>(`/api/collections/${id}`);
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 2000));
    if (Date.now() - t0 > 6 * 3600_000) throw new Error(`timeout: ${what}`);
  }
}

const t0 = Date.now();
const c = await api<{ collection: { id: string } }>("/api/collections", { method: "POST", json: { name: `Benchmark ${N}×${SEC}s ${new Date().toISOString()}` } });
const id = c.collection.id;

// 2) Upload (resumable API, bounded concurrency).
const tUp = Date.now();
let next = 0;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (next < files.length) {
      const f = files[next++]!;
      const buf = readFileSync(join(dir, f));
      const r = await api<{ uploadUrl: string; asset: { id: string } }>(`/api/collections/${id}/uploads`, { method: "POST", json: { filename: f, relativePath: `bench/${f}`, mime: f.endsWith(".srt") ? "application/x-subrip" : "video/mp4", bytes: buf.length, rightsAcknowledged: true } });
      await api(r.uploadUrl, { method: "PUT", body: buf, headers: { "content-range": `bytes 0-${buf.length - 1}/${buf.length}` } });
      await api(`/api/assets/${r.asset.id}/finalize`, { method: "POST" });
    }
  }),
);
const uploadMs = Date.now() - tUp;
const tIngest = Date.now();
await until(id, (v) => v.items.length === files.length && v.items.every((i) => !["pending", "probing"].includes(i.status)), "ingest");
const ingestMs = Date.now() - tIngest;

// 3) Index a representative subset first, then everything.
const tSub = Date.now();
const v0 = await api<View>(`/api/collections/${id}`);
const subset = v0.items.filter((i) => i.sourceName.endsWith(".mp4")).slice(0, Math.max(1, Math.round(N * 0.1))).map((i) => i.id);
await api(`/api/collections/${id}/index`, { method: "POST", json: { itemIds: subset } });
await until(id, (v) => subset.every((s) => ["indexed", "failed", "needs_transcript"].includes(v.items.find((i) => i.id === s)!.status)), "subset");
const subsetMs = Date.now() - tSub;
const tAll = Date.now();
await api(`/api/collections/${id}/index`, { method: "POST", json: { all: true } });
const fin = await until(id, (v) => v.items.filter((i) => i.sourceName.endsWith(".mp4")).every((i) => ["indexed", "failed", "needs_transcript"].includes(i.status)), "index all");
const indexMs = Date.now() - tAll;

// 4) Search latency.
const lat: number[] = [];
for (let q = 0; q < 50; q++) {
  const ts = Date.now();
  await api(`/api/collections/${id}/search?${q % 5 === 0 ? "theme=reaction" : `q=${WORDS[q % WORDS.length]}+${WORDS[(q * 7) % WORDS.length]}`}`);
  lat.push(Date.now() - ts);
}
clearInterval(sampler);
sample();
lat.sort((a, b) => a - b);
const segs = Number(execFileSync("psql", [process.env.DATABASE_URL ?? "postgresql://studio:studio@127.0.0.1:5432/studio", "-Atc", `select count(*) from transcript_segments where collection_id='${id}'`]).toString().trim());

const report = {
  hardware: { cpus: cpus().length, cpuModel: cpus()[0]?.model, memGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10, gpu: "none (software rendering)", storage: "local filesystem store" },
  workload: { recordings: N, sidecars: N, files: files.length, totalBytes, sourceSecEach: SEC, sourceHours: Math.round(((N * SEC) / 3600) * 100) / 100, segmentsIndexed: segs, transcription: "sidecar .srt import (no speech-to-text configured)" },
  timingsSec: { generate: genMs / 1000, upload: uploadMs / 1000, ingestAfterUpload: ingestMs / 1000, indexSubset10pct: subsetMs / 1000, indexRest: indexMs / 1000, total: (Date.now() - t0) / 1000 },
  throughput: { uploadMBps: Math.round((totalBytes / 1024 ** 2 / (uploadMs / 1000)) * 10) / 10, sourceHoursIndexedPerMinute: Math.round(((N * SEC) / 3600 / ((subsetMs + indexMs) / 60000)) * 100) / 100 },
  searchLatencyMs: { p50: lat[Math.floor(lat.length * 0.5)], p95: lat[Math.floor(lat.length * 0.95)], max: lat.at(-1) },
  peakRssMiB: Object.fromEntries(Object.entries(peaks).map(([k, v]) => [k, Math.round(v / 1024 ** 2)])),
  final: fin.totals,
  collectionId: id,
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
  at: new Date().toISOString(),
};
writeFileSync(join(out, `collection-${N}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
