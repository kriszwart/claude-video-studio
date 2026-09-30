# Video Studio

A standalone, project-based video creation studio. Pick a template, add your content and
assets, review a storyboard, render a draft **with audio**, revise scenes directly or through
the Creative Assistant (Claude), and export a playable MP4. Projects are revisioned, reopen
exactly as you left them, and can be saved as reusable templates.

> Working name. Not an official Anthropic product. Everything under `fixtures/sample/` is
> generated sample data for fictional brands (see its README).

## What works

| Area | Status |
| --- | --- |
| Seven template families: motion reel (T1), mascot story (T2), product launch (T3), vertical short (T4), talking head (T5), music video (T6), anime opening (T7) | Implemented, each with a real export test |
| Six presets: P1 presenter intro, P2 brand showreel, P3 event sizzle, P4 whiteboard, P5 course lesson, P6 product spec ad | Each exported and reviewed (see [docs/STATUS.md](docs/STATUS.md)) |
| Event collections: resumable folder upload or read-only server import, hash reuse, indexing plan with estimate, theme/free-text quote search, P3 sizzle from verbatim quotes with measured clean cuts | A19, A20; [docs/BENCHMARK.md](docs/BENCHMARK.md) |
| Creative profiles from a reference clip (measured vs interpreted traits, evidence frames), feedback → explicit versioned diff, pinned per project | A21 |
| Bounded render–review–repair with a stored quality report; product-fidelity check for generated shots; website screenshots through the SSRF guard | A22, A23, FR-15 |
| Capability routing to workers that can run Redraw/Skia; per-scene render cache | A29, A30 |
| Brief → storyboard → editable scenes → draft with audio → scene revision → MP4 → reopen → reuse as template | End to end (A01–A05, A10) |
| Transcript-first editing: subtitle import, silence/filler/retake proposals, EDL with source→output map, editorial beats with anchors, style variants | A11, A17, A18, A24 |
| Music analysis (tempo/beats/downbeats/sections), markers, cuts fitted to music, accents | A12 |
| Generation pipeline with budgets, ledger, webhooks, recovery | Built and tested against a local **fake** queue only; live fal is **unverified** |
| Redraw (WebGPU) and Skia (CanvasKit) graphics layers | Capability proofs pass for both; see [docs/GRAPHICS.md](docs/GRAPHICS.md) |
| Security: password mode, workspace isolation, SSRF-guarded URL import, upload validation | A14, A15 against a production build |

The authoritative, per-requirement checklist with evidence and every blocked live check is
[docs/STATUS.md](docs/STATUS.md). The build plan is [docs/PLAN.md](docs/PLAN.md).

## Architecture

```
apps/web        Next.js 16 app: UI + REST API (thin; all rules live in packages)
apps/worker     Job runner (BullMQ + Postgres leases): ingest, render, TTS, transcription,
                music analysis, generation, collections, sizzle, reference analysis,
                quality review, screenshots, cleanup
packages/domain       Project document schema, timeline maths, typed operations, budgets,
                      transcript/EDL/beat logic (pure, unit-tested)
packages/templates    Template definitions (T1–T7, presets), instantiation, program/music builders
packages/compositor   Document → HyperFrames composition (HTML/GSAP), layouts, characters
packages/graphics     Skia and Redraw adapters + versioned component catalog
packages/rendering    HyperFrames render, FFmpeg mixing/verification, stills, music analysis
packages/providers    Claude planner/editor, TTS, transcription, fal queue adapter
packages/db           Drizzle schema + migrations, services (projects, jobs, ledger, auth, storage)
```

The database is authoritative. Every edit is a typed operation against a base revision
(409 when stale) and produces an immutable revision. Long work is a persisted job: enqueued
through a transactional outbox, claimed with a lease and heartbeat, retried with backoff,
and reconciled after a crash. Renders are pinned to the revision they were requested for.

## Setup

Requirements: Node ≥ 22, pnpm 10, PostgreSQL 16, Redis 7, FFmpeg (with libx264), a
Chromium headless shell (Playwright's is auto-detected), optionally `pico2wave`/`espeak-ng`
for local narration.

```bash
pnpm install
cp .env.example .env            # fill APP_SECRET / APP_ENCRYPTION_KEY for anything but local dev
docker compose -f infra/docker-compose.yml up -d postgres redis   # or native services
pnpm db:migrate
pnpm fixtures                   # (re)generate sample fixtures (already committed)
scripts/dev-worker.sh start     # worker in the background (log: data/worker.log)
scripts/dev-web.sh start        # web on http://127.0.0.1:3000 (log: data/web.log)
```

Local mode (`STUDIO_AUTH_MODE=local`) is a passwordless single owner and **only answers
loopback requests**. Anything reachable by others must use password mode; see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### Claude: your subscription by default

AI planning and the Creative Assistant use **your Claude plan (Pro/Max) through Claude Code**
— no Anthropic API key and no API charges:

1. Install Claude Code and run `claude` once in a terminal on the same computer; sign in with
   `/login` using your Claude subscription.
2. Open **Settings → Claude** and click **Check runtime**. It shows the signed-in plan (the
   check sends no prompt and uses none of your plan).

Calls go through the official Claude Agent SDK with no built-in tools, no user settings, a
per-project scratch directory and cancellation; the studio never reads or stores your login.
They count toward your plan's usage limits. At a limit the job **pauses** with a Resume
button — the studio never switches accounts, enables extra usage or falls back to paid API
billing. If `ANTHROPIC_API_KEY` (or another billing override) is set in the server
environment, Settings warns by name; it is not passed to Claude Code. A separately billed
API key is an explicit alternative (**Settings → Claude → API key**).

The subscription runtime is only for a **personal local studio** (local mode, one owner, this
computer): Anthropic does not allow products to offer claude.ai login or plan limits to other
users, so a password-mode/hosted studio must use API mode. When Claude Code isn't signed in,
AI actions show a setup link, everything else keeps working, and the Assistant tab offers a
**Claude Code handoff**: download the project file, ask Claude Code for the change in your own
terminal, and import the `operations.json` it writes (validated like any assistant edit).

Other providers are optional. Without keys the studio still does everything that doesn't need
them (manual editing, local narration, subtitle-based transcripts, rendering, exports) and
each AI/paid action explains what to configure. Keys are entered in **Settings** (stored
AES-256-GCM encrypted) or supplied as server environment variables; they are never sent to
the browser.

### Environment variables (names only)

`DATABASE_URL`, `REDIS_URL`, `STORAGE_DRIVER`, `DATA_DIR`, `S3_BUCKET`, `S3_ENDPOINT`,
`S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `STUDIO_AUTH_MODE`, `APP_SECRET`,
`APP_ENCRYPTION_KEY`, `SETUP_TOKEN`, `CLAUDE_RUNTIME`, `CLAUDE_CODE_EXECUTABLE`,
`CLAUDE_RUNTIME_TIMEOUT_MS`, `STUDIO_CLAUDE_WORKDIR`, `STUDIO_ALLOWED_ORIGINS`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `CLAUDE_EFFORT`,
`CLAUDE_MAX_TOKENS`, `CLAUDE_FALLBACKS`, `STUDIO_ANTHROPIC_BASE_URL`, `ELEVENLABS_API_KEY`,
`ELEVENLABS_TTS_MODEL`, `ELEVENLABS_STT_MODEL`, `WHISPER_CPP_BIN`, `WHISPER_CPP_MODEL`,
`FAL_KEY`, `FAL_QUEUE_BASE_URL`, `FAL_JWKS_URL`, `FAL_WEBHOOK_SIGNATURE`, `FAL_WAIT_MAX_SEC`,
`PUBLIC_BASE_URL`, `REDRAW_TARBALL`, `REDRAW_SHA256`, `REDRAW_DISABLED`,
`HYPERFRAMES_CHROME_PATH`, `RENDER_WORKERS`, `WORKER_CONCURRENCY`, `PREVIEW_SCALE`,
`MAX_UPLOAD_BYTES`, `MAX_SOURCE_SECONDS`, `FFMPEG_PATH`, `FFPROBE_PATH`, `DB_POOL_MAX`,
`QUEUE_NAME`, `DELETE_RECOVERY_DAYS`, `KEEP_WORK_DIRS`, `SKIP_PROXIES`,
`ALLOW_BUILTIN_TEMPLATE_REWRITE`; test-only: `VS_TEST_TRUSTED_OUTPUT`, `FAKE_FAL_PORT`, `STUDIO_CLAUDE_SDK_DOUBLE`, `STUDIO_CLAUDE_SDK_DOUBLE_STATE`,
`PW_CHROMIUM`, `E2E_BASE_URL`, `E2E_PROD_URL`. Descriptions are in `.env.example`.

### Redraw (licensed)

Redraw is a paid, non-redistributable package. It is **not** in this repository. Point
`REDRAW_TARBALL` at the owner's release tarball (e.g. `vendor/redraw/redraw-1.3.3.tgz`,
git-ignored) and set `REDRAW_SHA256`. Without it the Redraw capability is reported as
unavailable and projects using Redraw layers fail with an explicit error instead of a blank
render. Details: [docs/GRAPHICS.md](docs/GRAPHICS.md).

## Tests

```bash
pnpm typecheck
pnpm test                                   # unit/integration (vitest)
cd apps/web && npx playwright test          # end-to-end against a running web + worker
```

End-to-end suites (in `apps/web/test/e2e/`) drive the real UI/API, wait for real jobs, and
download, probe and inspect the exported MP4s (frames under `artifacts/e2e/`):

| Spec | Covers |
| --- | --- |
| `m1-product-launch` | A01–A05, A10 (UI flow, scene-only revision, reopen, template reuse, portrait) |
| `m2-families` | T4 narration + captions, T1 reel, P2 Redraw showreel |
| `m3-talking-head`, `m3-ui` | A11, A17, A18, cut review, beat anchors (drag), variants |
| `m4-music-mascot` | A12: excerpt identity by audio correlation, section cuts, accents; T2 |
| `generation` | A08, A09, A13 against the TEST-ONLY fake fal queue (`scripts/fake-fal.ts`) |
| `reliability` | A06 missing credentials, A07 worker SIGKILL mid-export |
| `claude-runtime` | A31–A33 and the Claude Code handoff against the TEST-ONLY Agent SDK double (`scripts/fake-claude-sdk.mjs`) |
| `security` | A14, A15, A33 (multi-user mode refuses the subscription runtime) against a password-mode production build (`E2E_PROD_URL`) |
| `a16-templates` | A16: final 1080p export of every core template + P6, fully decoded |
| `m6-collections` | A20 interrupted/limited/hash-reused ingest; A19 quote search → P3 sizzle, clean cuts, verbatim captions, export envelope match |
| `m6-profiles`, `m6-quality`, `m6-fidelity`, `m6-screenshot` | A21, A22, A23, FR-15 screenshot isolation |
| `m7-graphics` | A28 mixed HTML/video/Skia/Redraw export vs editor frames; A30 per-scene cache and template reuse; A29 routing with a Redraw-less worker |

`generation` needs `npx tsx scripts/fake-fal.ts` and the fixture wiring in `.env` described in
`.env.example`; `security` needs `next build` + `next start` in password mode and two users
created with `tsx scripts/create-user.ts`.

## Documentation

- [docs/PLAN.md](docs/PLAN.md) — implementation plan and milestone record
- [docs/STATUS.md](docs/STATUS.md) — requirements/status checklist, test evidence, blocked live checks
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — production setup, isolation, backups, restore
- [docs/GRAPHICS.md](docs/GRAPHICS.md) — Skia and Redraw integration, capability proofs
- [docs/review/A16.md](docs/review/A16.md) — reviewed export of every template
- [docs/BENCHMARK.md](docs/BENCHMARK.md) — large-library collection benchmark
- `scripts/clean-worker-check.sh` — reproduce a worker (dependencies + Redraw + Skia proofs) from a clean clone
