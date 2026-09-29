# Implementation plan

Source of truth: `CLAUDE-VIDEO-STUDIO-PRD.md` v1.2 (including §21–27). Status per requirement and
acceptance gate is tracked in [STATUS.md](STATUS.md); this file records how the work was sequenced
and why.

## Principles

- **Real workflow first.** Every milestone ends with a playable, inspected export produced by the
  same pipeline users run (brief → storyboard → editable scenes → preview → revision → MP4 →
  reopen → reuse). No simulated generation, static previews or fake progress.
- **Separation of concerns.** `packages/domain` (validated document, typed operations, timing),
  `packages/templates` (recipes, instantiation), `packages/compositor` (HTML/GSAP composition),
  `packages/rendering` (HyperFrames render, mix, verification, analysis), `packages/graphics`
  (Skia/Redraw adapters), `packages/providers` (Claude, ElevenLabs, fal, whisper.cpp),
  `packages/db` (Postgres services, jobs) — the Next.js app and the worker only compose them.
- **Honest integrations.** Provider contracts are implemented from the official SDK/REST
  definitions and tested against test-only fakes; nothing is reported as live-verified without a
  real call with real credentials (see STATUS → "Blocked live checks").
- **Everything is a revision or a job.** Edits are typed operations against a base revision
  (stale → 409); long work is a persisted job with leases, retries and recovery.

## Stack (as proposed in PRD §8, versions pinned in `package.json` / lockfile)

Next.js 16 (App Router) + React 19 UI; Node 22 worker; Postgres 16 (Drizzle ORM); Redis + BullMQ
queue fed by a transactional outbox; HyperFrames 0.8.90 + GSAP 3.15 renderer (headless
Chromium); ffmpeg 6.1 for mixing, loudness and verification; CanvasKit (Skia) 0.42 and the owner's
licensed Redraw 1.3.3 (+ TypeGPU 0.12.6) for graphics layers. Documented deviations: none of the
stack was replaced; H.264 decode is unavailable in the pinned headless shell, so stills paint
ffmpeg-decoded frames over `<video>` elements (the export path already does this).

## Milestones

| Milestone | Scope | Result |
| --- | --- | --- |
| M0 | Domain model, compositor, render/mix/verify pipeline, Skia + Redraw capability proofs | Done — proofs in `docs/GRAPHICS.md` |
| M1 | T3 product launch end to end: brief, uploads, storyboard, scene editor, preview, scene revision, export, reopen, save as template | Done — A01–A05, A10 |
| M2 | T1 motion reel, T4 vertical short (local TTS + captions), P2 showreel with Redraw ribbon, Fast Social | Done |
| M3 | T5 talking head: transcript-first cuts, EDL, editorial beats, P1/P4/P5, three-style variants, strict/flexible mode | Done — A11, A17, A18, A24 |
| M4 | T2 mascot story (persistent character), T6 music video (beat/downbeat/section analysis, excerpt, markers) | Done — A12 |
| M5 | T7 anime opening + P6 spec ad: shot lists, fal queue adapter (webhooks, recovery), budgets/ledger, reliability, security | Done with fake provider — A06–A09, A13–A16; live fal blocked |
| M6 | Collections (resumable ingest, hash reuse, search), P3 Event Sizzle, creative profiles from references, bounded review–repair, product fidelity, benchmark | Done — A19–A23; benchmark in `docs/BENCHMARK.md` |
| M7 | Graphics library completion: capability routing, per-scene render cache, mixed composition, clean-worker reproduction | Done — A25–A30 (software WebGPU only) |

## Remaining requirements

Everything that depends on credentials or network access that this environment does not have is
listed in STATUS → "Blocked live checks", with the exact command to run once available.

## References consulted

- HyperFrames, GSAP, CanvasKit and the licensed Redraw 1.3.3 package documentation/type
  definitions (pinned versions above); `@fal-ai/client` 1.10.1 and `@elevenlabs/elevenlabs-js`
  2.70.0 type definitions for the provider contracts (their hosts are unreachable from here).
- HyperFrames Student Kit (public repository): MIT-licensed code, brand assets excluded. Read as a
  reference for transcript cutting, EDL review, captions and a style library. None of its files
  were copied, and its agent instructions (`SKILL.md`/prompts) are not used as runtime
  authority — creative profiles are validated product data (FR-17).
