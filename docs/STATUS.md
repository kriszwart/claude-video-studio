# Requirements and acceptance status

Legend: ✅ done and verified here · 🟡 implemented, verified only against a test double or
software-only runtime (live check blocked, see bottom) · ❌ not done.

Evidence paths refer to what the tests write under `artifacts/` (not committed; re-run the named
spec to regenerate). Every export listed was probed (codecs, dimensions, fps, duration), fully
decoded, loudness-measured, and reviewed frame by frame; audio was reviewed with loudness,
spectrum and level measurements (this environment has no speakers — "listened" means measured).

## Functional requirements

| ID | Requirement | Status | Where / evidence |
| --- | --- | --- | --- |
| FR-01 | Projects & persistence (revisions, undo/redo, archive/restore, soft delete) | ✅ | `packages/db/src/services/projects.ts`; A02, A03, A10 |
| FR-02 | Template gallery with honest availability | ✅ | `/templates`; `lib/server/templates.ts` (capabilities from live workers) |
| FR-03 | Brief & references (uploads, SSRF-guarded URL import) | ✅ | `apps/worker/src/net/safeFetch.ts` + tests; A15 |
| FR-04 | Brand kits (versioned, applied as snapshot) | ✅ | `/brand-kits`; A01 |
| FR-05 | Storyboard with real frames | ✅ | keyframes job (per-scene cache, A30) |
| FR-06 | Scene editor (layers, timing, locks, transitions, media) | ✅ | `components/editor/*`; A02 |
| FR-07 | Creative Assistant (typed ops, base revision, guards) | 🟡 | `packages/providers/src/claude/editor.ts`; guard/stale logic tested; **live Claude blocked** |
| FR-08 | Asset management (content sniffing, dedupe, provenance, resumable upload) | ✅ | `/assets`; A20 resumable chunks |
| FR-09 | Audio & captions (TTS, mix, ducking, loudness, SRT/VTT) | ✅ local TTS / 🟡 ElevenLabs | M2 T4; ElevenLabs TTS blocked |
| FR-10 | Draft preview & verified export | ✅ | `packages/rendering/src/verify.ts`; all exports |
| FR-11 | Save as template (independence check, variables) | ✅ | A04; A30 template reuse |
| FR-12 | Jobs & costs (outbox, leases, retries, ledger) | ✅ | A06–A09 |
| FR-13 | Transcript-first editorial pipeline | ✅ subtitles / 🟡 STT | A11, A17; ElevenLabs STT & whisper.cpp model blocked |
| FR-14 | Editorial beat sheet & placement | ✅ | A17, A24 |
| FR-15 | Asset research & shot sourcing (policy, provenance, screenshots, image→video chain) | ✅ / 🟡 generation | acquisition policy, `/api/projects/:id/asset-requests`, screenshot capture (`m6-screenshot.spec.ts`); fal live blocked |
| FR-16 | Multi-recording event collections | ✅ | A19, A20; `docs/BENCHMARK.md` |
| FR-17 | Creative profiles & reference analysis | ✅ | A21 |
| FR-18 | Bounded render–review–repair | ✅ | A22 |
| FR-19 | Graphics component library (Skia ×4, Redraw ×3) | ✅ | `packages/graphics/src/catalog.ts`; `docs/GRAPHICS.md` |
| FR-20 | Deterministic frame evaluation & export | ✅ (software WebGPU) | capability proofs; A27 |
| FR-21 | Capability routing & graceful recovery | ✅ | A29; per-scene cache A30 |

## Template families (T1–T7) and presets (P1–P6)

| ID | Name | Status | Evidence |
| --- | --- | --- | --- |
| T1 | Motion graphics reel | ✅ | `a16/t1-motion-reel.mp4` |
| T2 | Mascot story | ✅ | `a16/t2-mascot-story.mp4`, A12 |
| T3 | Product launch | ✅ | `a16/t3-product-launch.mp4`, A01 |
| T4 | Vertical short + voiceover | ✅ | `a16/t4-vertical-short.mp4` |
| T5 | Talking-head enhancement | ✅ | `a16/t5-talking-head.mp4`, A11 |
| T6 | Animated music video | ✅ | `a16/t6-music-video.mp4`, A12 |
| T7 | Anime opening | ✅ supplied footage / 🟡 generated | `a16/t7-anime-opening.mp4`; generation via fake fal only |
| P1 | Presenter Motion Intro | ✅ | A18 variants, `m3-talking-head` |
| P2 | Brand/Channel Showreel (Redraw ribbon) | ✅ | `p2-showreel.mp4` (`m2-families`) |
| P3 | Event Sizzle Reel | ✅ | `m6-event-sizzle.mp4` (A19) |
| P4 | Whiteboard Explainer (Skia sketches) | ✅ | `a18-whiteboard.mp4` |
| P5 | Course Lesson | ✅ | `a18-course.mp4` |
| P6 | Physical Product Spec Ad | ✅ uploads-only / 🟡 generated shots | `a16/p6-product-spec-ad.mp4`, A23 |
| — | Fast Social treatment (T4/T5) | ✅ | profile preset `fast-social`; `a18-social.mp4` |

## Acceptance gates

| ID | Scenario | Status | Spec / evidence |
| --- | --- | --- | --- |
| A01 | Product launch from uploaded brand assets | ✅ | `m1-product-launch.spec.ts` → `a01-final.mp4` |
| A02 | Revise only scene three | ✅ | `m1-product-launch.spec.ts` (other scene hashes unchanged) |
| A03 | Reload and reopen | ✅ | `m1-product-launch.spec.ts` |
| A04 | Save template, use for another product | ✅ | `m1-product-launch.spec.ts` → `a04-second-product.mp4` |
| A05 | Portrait version | ✅ | `m1-product-launch.spec.ts` → `a05-portrait.mp4` |
| A06 | Missing/invalid credentials | ✅ | `reliability.spec.ts` |
| A07 | Worker crash during export | ✅ | `reliability.spec.ts` → `a07-recovered.mp4` (one export) |
| A08 | Duplicate/out-of-order provider callbacks | 🟡 | `generation.spec.ts` (fake fal, signed webhooks) |
| A09 | Budget exceeded / unknown price | 🟡 | `generation.spec.ts` (fake fal) |
| A10 | Edits while assistant/render runs | ✅ render / 🟡 assistant | `m1-product-launch.spec.ts` (render pinned to its revision; stale base → 409); live assistant blocked |
| A11 | Talking-head cut mapping & caption sync | ✅ | `m3-talking-head.spec.ts` → `a11-presenter-cut.mp4` |
| A12 | Music and mascot workflows | ✅ | `m4-music-mascot.spec.ts` |
| A13 | Anime generation fails halfway | 🟡 | `generation.spec.ts` (fake fal) |
| A14 | Cross-workspace access | ✅ | `security.spec.ts` (password-mode production build) |
| A15 | Unsafe URL / composition / upload | ✅ | `security.spec.ts`, `safeFetch.test.ts`, compositor injection tests |
| A16 | All seven core templates exported and reviewed | ✅ | `a16-templates.spec.ts`; review in `docs/review/A16.md` |
| A17 | Transcript cuts and overlay cues | ✅ | `m3-talking-head.spec.ts` |
| A18 | Same source in three styles | ✅ | `m3-talking-head.spec.ts` |
| A19 | Multi-recording event story | ✅ | `m6-collections.spec.ts` → `m6-sizzle-report.json` |
| A20 | Interrupted collection ingest | ✅ | `m6-collections.spec.ts` |
| A21 | Style learning and reuse | ✅ | `m6-profiles.spec.ts` |
| A22 | Automated review and repair | ✅ | `m6-quality.spec.ts` → `m6-quality-report.json` |
| A23 | Physical product fidelity | ✅ check / 🟡 generation | `m6-fidelity.spec.ts` (fake fal output flagged, rejected, replaced) |
| A24 | Strict vs flexible creative mode | ✅ | `packages/domain/test/transcript.test.ts` |
| A25 | Authorized Redraw build | ✅ | redraw 1.3.3, sha256 `3cb51684…474f`; `scripts/clean-worker-check.sh`; P2 export |
| A26 | Skia integration | ✅ | P4/P5 exports, `m7-mixed.mp4` (paths, text, image mask) |
| A27 | Deterministic seeking | ✅ | capability proofs (repeat/out-of-order/device-loss byte-identical) |
| A28 | Mixed composition | ✅ | `m7-graphics.spec.ts` → `m7-preview-vs-export.json` |
| A29 | Unsupported runtime / device loss | ✅ | `m7-graphics.spec.ts` (Redraw-less worker; job waits, nothing blank), device-loss proof |
| A30 | Reuse and deployment | ✅ | `m7-graphics.spec.ts` → `m7-cache.json`; `scripts/clean-worker-check.sh` |

## Final test run (2026-09-29, committed code)

| Suite | Result |
| --- | --- |
| Unit/integration (`pnpm test`, vitest) | 72 passed |
| Typecheck (all 9 packages) + Redraw runtime against the real package | clean |
| `m6-screenshot` | 1 passed |
| `m6-collections` (A19, A20) | 2 passed |
| `m6-profiles` (A21), `m6-quality` (A22), `m6-fidelity` (A23) | 1 + 1 + 1 passed |
| `generation` (A08, A09, A13; fake fal) | 5 passed ×3 consecutive runs; one earlier run had A08 fail (its error output was not captured) — watch for flakiness |
| `reliability` (A06, A07) | 2 passed |
| `m1-product-launch` (A01–A05, A10) | 6 passed (after fixing the asset-library listing regression) |
| `m3-ui`, `m3-talking-head` (A11, A17, A18) | 1 + 2 passed |
| `m4-music-mascot` (A12) | 2 passed |
| `a16-templates` (A16) | 8 passed (533 s) |
| `m2-families` (T4, T1, P2 Redraw showreel) | 3 passed |
| `m7-graphics` (A28, A29, A30) | 2 passed (11.9 min) |
| `security` (A14 incl. collections/profiles/quality endpoints, A15) vs password-mode production build | 4 passed |
| `scripts/clean-worker-check.sh` (A25/A30) | fresh clone of commit `5cffc1c`, `pnpm install --frozen-lockfile --offline`, Redraw tarball sha256 verified; Skia proof 1920×1080 export OK (18.4 s); Redraw proof 480×270 export OK (215 s); repeated, out-of-order and post-device-loss frames byte-identical |
| Collection benchmark | 400 files / 10 h source indexed; see [BENCHMARK.md](BENCHMARK.md) |

## Blocked live checks (exact reasons)

These integrations are implemented against the providers' official SDK/REST contracts and tested
against test doubles only. They are **not** claimed as verified.

| Integration | Blocker here | To verify |
| --- | --- | --- |
| Anthropic Claude (planner, assistant, feedback wording) | No `ANTHROPIC_API_KEY` for this app (the session's own credentials must not be used) | Add a key in Settings → Providers, then create a project with AI planning and use the Assistant tab; request/response validation is unit-tested in `packages/providers/test` |
| ElevenLabs TTS and Scribe STT | No key; `elevenlabs.io` unreachable | Add a key in Settings; create a T4 with an ElevenLabs voice; transcribe a T5 without subtitles |
| fal image/video generation, webhooks | No key; `fal.run` unreachable; webhooks need a public URL | Configure fal key + model endpoints/prices in Settings; set `PUBLIC_BASE_URL`; generate a T7 shot |
| whisper.cpp local STT | Model download (Hugging Face) blocked | Set `WHISPER_CPP_BIN` and `WHISPER_MODEL`; transcribe a T5 without subtitles |
| Segmentation provider (background removal) | Not integrated (no verified provider contract) | — (templates never require it) |
| Redraw on hardware GPU | Only SwiftShader software WebGPU here (~4 s/frame at 540p) | Run `scripts/clean-worker-check.sh` on a GPU worker |

## Known limitations

- Product fidelity is a colour measure only; shape and logo placement need human review (the UI says so).
- Automated review measures fit, fonts, captions, timing, loudness and decode; contrast, presenter
  coverage and speech naturalness are left to human review with the stored evidence frames.
- Redraw export is slow on software WebGPU; production should use GPU workers (routing supports it).
