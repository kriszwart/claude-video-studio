# Event-collection benchmark (FR-16)

Script: `scripts/bench-collection.ts` (run against a running web + worker). It generates N synthetic
recordings (SAMPLE test-pattern video with a distinct tint/label and tone per file, plus a
generated `.srt` of pseudo-sentences per file), then uses the public API exactly as the browser
does: create a collection → reserve + upload every file with `Content-Range` (resumable path) →
finalize → wait for ingest → index a 10% subset → index the rest → run 50 searches (free text and
themes). Peak RSS is sampled every second from `ps`.

## Result (2026-09-29)

| | |
| --- | --- |
| Hardware | 4 vCPU Intel Xeon @ 2.1 GHz, 15.7 GiB RAM, no GPU, local-disk storage driver, Postgres 16 + Redis on the same VM |
| Software | web = `next dev` (development server), 1 worker with concurrency 2 |
| Files | 400 (200 recordings × 180 s at 320×180/15 fps + 200 subtitle sidecars) |
| Bytes | 841 MB (802 MiB) |
| Source duration | 10.0 h |
| Segments indexed | 8,118 |
| Upload (4 parallel clients, chunked API) | 80 s → 10 MB/s |
| Ingest after the last upload (probe, hash, dedupe) | 24 s (ingest overlapped the uploads) |
| Index 10% subset / remaining 90% | 2.5 s / 3.6 s (sidecar import) |
| Search latency (50 queries, via the dev server) | p50 154 ms, p95 197 ms, max 209 ms |
| Peak RSS | worker 1.56 GiB (incl. its Chromium), web 2.42 GiB (dev server), Postgres 0.3 GiB |
| Final state | 200 indexed, 200 sidecars stored, 0 failed |

Report: `artifacts/bench/collection-200.json` (regenerate with
`BENCH_FILES=200 BENCH_SECONDS=180 npx tsx scripts/bench-collection.ts`).

## What this does and doesn't show

- It measures the application path (API, storage, job queue, database, search) at 400 files /
  10 h of source on a small VM. It is **not** evidence of unlimited scale.
- Transcripts came from sidecar subtitles because no speech-to-text provider is available here.
  With ElevenLabs Scribe or whisper.cpp, transcription time and cost dominate and are bounded by
  worker concurrency; the indexing plan shows the minutes and (with `STT_PRICE_USD_PER_HOUR`)
  the price before anything runs.
- The recordings are small (≈4 MB for 3 min). Real event footage is 100–1000× larger per minute;
  upload throughput is then network-bound, and ingest (hashing, probing) is I/O-bound. The
  resumable chunk protocol keeps interrupted multi-GB uploads from restarting (A20).
- The first attempt used recordings that were byte-identical in groups; the ingest correctly
  deduplicated them by content hash and marked the copies — that run was discarded and the
  fixtures made unique.
- Search uses Postgres full-text search over segment rows with a GIN index; at much larger
  libraries (≫10⁶ segments) consider a dedicated search index — measured, not assumed.
