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
| FR-07 | Creative Assistant (typed ops, base revision, guards) | 🟡 | `packages/providers/src/claude/editor.ts`; guard/stale logic tested; runs through the subscription runtime (SDK test double in `claude-runtime.spec.ts`); **live Claude blocked** |
| FR-08 | Asset management (content sniffing, dedupe, provenance, resumable upload) | ✅ | `/assets`; A20 resumable chunks |
| FR-09 | Audio & captions (TTS, mix, ducking, loudness, SRT/VTT) | ✅ local TTS / 🟡 ElevenLabs, OmniVoice | M2 T4; ElevenLabs TTS blocked |
| FR-10 | Draft preview & verified export | ✅ | `packages/rendering/src/verify.ts`; all exports |
| FR-11 | Save as template (independence check, variables) | ✅ | A04; A30 template reuse |
| FR-12 | Jobs & costs (outbox, leases, retries, ledger) | ✅ | A06–A09 |
| FR-13 | Transcript-first editorial pipeline | ✅ subtitles / 🟡 STT | A11, A17; ElevenLabs STT & whisper.cpp model blocked |
| FR-14 | Editorial beat sheet & placement | ✅ | A17, A24 |
| FR-15 | Asset research & shot sourcing (policy, provenance, screenshots, image→video chain) | ✅ / 🟡 generation | acquisition policy, `/api/projects/:id/asset-requests`, screenshot capture (`m6-screenshot.spec.ts`); fal live blocked |
| FR-15b | Free footage search & import (Internet Archive, Wikimedia Commons, Pexels, Pixabay; Moving Image Archive assisted, no automated access) with per-item licence, credits | 🟡 | `packages/providers/src/footage/*` + `footage.test.ts` (20 cases); `footage.spec.ts` (4) against the API stand-in; **live APIs blocked here** |
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
| A23 | Physical product fidelity | ✅ check / 🟡 generation | `m6-fidelity.spec.ts` (fake fal output flagged, rejected, replaced); `product-check.spec.ts` (Claude shape/logo check, test double) |
| A24 | Strict vs flexible creative mode | ✅ | `packages/domain/test/transcript.test.ts` |
| A25 | Authorized Redraw build | ✅ | redraw 1.3.3, sha256 `3cb51684…474f`; `scripts/clean-worker-check.sh`; P2 export |
| A26 | Skia integration | ✅ | P4/P5 exports, `m7-mixed.mp4` (paths, text, image mask) |
| A27 | Deterministic seeking | ✅ | capability proofs (repeat/out-of-order/device-loss byte-identical) |
| A28 | Mixed composition | ✅ | `m7-graphics.spec.ts` → `m7-preview-vs-export.json` |
| A29 | Unsupported runtime / device loss | ✅ | `m7-graphics.spec.ts` (Redraw-less worker; job waits, nothing blank), device-loss proof |
| A30 | Reuse and deployment | ✅ | `m7-graphics.spec.ts` → `m7-cache.json`; `scripts/clean-worker-check.sh` |
| A31 | Subscription-first local AI (no API key; observed mode reported) | 🟡 | `claude-runtime.spec.ts` (SDK test double: plan "max" → assistant edit applied, ledger `claude_subscription` / $0, no API-key env, scoped tooling) → `a31-report.json`, `a31-settings-claude.png`. Real runtime here: refused before sending (see below). **Live check with a real subscription login blocked** |
| A32 | Limit/runtime failure → paused, recoverable, no paid fallback | ✅ (double) | `claude-runtime.spec.ts`: rejected 5-hour window → job `paused` with reset time, revision unchanged, no ledger rows, not auto-retried; Resume from the editor → applied; paused job cancel → `a32-report.json`, `a32-paused.png`; unit tests in `packages/providers/test/subscription.test.ts` |
| A33 | Loopback/origin/session protection; scoped tooling; no subscription secrets in browser/DB/logs | ✅ | `claude-runtime.spec.ts` (cross-origin/`null`/cross-site writes → 403, same-origin OK, non-loopback Host → 403, server listens on 127.0.0.1 only, override values absent from API/DB/logs); `security.spec.ts` (password mode never offers or starts the subscription runtime) |

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

## §28 test run (2026-09-30, subscription-first runtime)

| Suite | Result |
| --- | --- |
| Unit/integration (`pnpm test`) incl. `subscription.test.ts` (10 cases: scoped options, env allowlist, API-login refusal before sending, limit → `usage_limit`, login loss, cancel, status check without a prompt) | 82 passed |
| Typecheck (all packages + web + worker) | clean |
| `claude-runtime` (A31, A32, handoff, A33; SDK test double) | 4 passed |
| `security` (A14, A15, A33 password mode) vs password-mode production build | 5 passed |
| `m1-product-launch` (A01–A05, A10), `reliability` (A06 with the new `claude_unavailable` setup error, A07) | 8 passed |
| Real runtime status check in this container (no prompt sent) | `billing_mismatch` — observed `api_key` ("Claude API"); refused as designed |

Suites not re-run for §28 (no code path they cover changed beyond the job-state enum and API
origin check): `m2`–`m7`, `generation`, `a16-templates`; their results above stand.

## Full regression run (2026-10-02, all suites)

Every unit and end-to-end suite against the committed code after Send to Lanternist and picture
hosting, the glitch/phone/loop checks, sound effects, screen demos, counting numbers, lock to the
beat, the critic's "what I'd still change" and notes as problem + result, and the pro editor UI.
Local stand-ins as before (Claude Agent SDK test double, fake fal/OpenRouter/Jev/Lanternist/S3,
fake OmniVoice/ElevenLabs).

| Suite | Result |
| --- | --- |
| Unit/integration (`pnpm test`, vitest, 45 files) | 239 passed, 1 skipped (macOS-only) |
| Typecheck (all packages + web + worker) | clean |
| End-to-end on the dev server (39 specs, 1.5 h, including `m7-graphics` Redraw + Skia, 12.7 min) | 86 passed, 1 failed, 1 not run (next test in that serial group) |
| `jev` re-run after the test fix below | 4 passed |
| `security` (A14, A15, A33) vs password-mode production build | 5 passed |

The one failure: `jev` still expected templates built from the owner's recording to be hidden until
footage is attached. Since 2026-10-01 they are suggested beforehand, marked "add your recording"
(commit bc69b48); the test now checks that. No application code changed as a result.

## Full regression run (2026-10-01, all suites)

Every unit and end-to-end suite, run against the committed code after the phase 1–4 features, the
quality checks (contrast, framing, product check, voiceover pacing), GPU auto mode and the setup
checklist. Local stand-ins as before: Claude Agent SDK test double, fake fal/OpenRouter,
fake OmniVoice/ElevenLabs.

| Suite | Result |
| --- | --- |
| Unit/integration (`pnpm test`, vitest, 33 files) | 187 passed |
| Typecheck (all packages + web + worker) | clean |
| End-to-end, full suite on the dev server (`pnpm e2e`, 34 specs, 1.1 h) | 65 passed, 5 failed, 8 not run (later tests in a failed serial group) |
| Re-run of the 13 failed/not-run tests after the fixes below | 13 passed |
| `m7-graphics` (A28–A30, Redraw + Skia, software WebGPU) | 2 passed (11.0 min) |
| `security` (A14, A15, A33) vs password-mode production build | 5 passed |

The five first-pass failures, and what they were:

- `elevenlabs`, `omnivoice`: the tests picked a provider card as the first `<li>` naming the
  provider; the new Get started checklist now comes first. Tests select `#provider-<id>`
  (the OmniVoice failure followed from the ElevenLabs test timing out with its settings in place).
- `m7-graphics`: assumed a cold keyframe cache; caches are content-keyed across the studio, so a
  second run on the same database found its scenes cached. The test now uses a per-run seed.
- `shot-plan`: connection reset while the dev server restarted (container); passes on re-run.
- `security`: not meant for the dev server; it needs the password-mode production build above.

No application code changed as a result; all were test assumptions or environment.

## Blocked live checks (exact reasons)

These integrations are implemented against the providers' official SDK/REST contracts and tested
against test doubles only. They are **not** claimed as verified.

| Integration | Blocker here | To verify |
| --- | --- | --- |
| Claude subscription runtime (A31 live; planner, assistant) | This container's Claude Code is not the owner's subscription: the real runtime reports `subscriptionType: "Claude API"` (API-billed), and the studio correctly refuses it before sending anything (`state: billing_mismatch`, observed `api_key`). The session's own credentials must not be used for the app. | On your computer: sign in to Claude Code with your Pro/Max plan (`claude`, `/login`), open Settings → Claude → Check runtime (expect "signed in with a Claude subscription (max)"), then create a project with "Create and plan storyboard with Claude" and use the Assistant tab. Settings shows the observed mode; the ledger rows read `claude_subscription`. |
| Claude API mode (optional) | No API key for this app | Settings → Claude → API key, add the key, then as above |
| ElevenLabs TTS and Scribe STT | No key; `elevenlabs.io` unreachable | Add a key in Settings; create a T4 with an ElevenLabs voice; transcribe a T5 without subtitles |
| fal image/video generation, webhooks | No key; `fal.run` unreachable; webhooks need a public URL | Configure fal key + model endpoints/prices in Settings; set `PUBLIC_BASE_URL`; generate a T7 shot |
| whisper.cpp local STT | Model download (Hugging Face) blocked | Set `WHISPER_CPP_BIN` and `WHISPER_MODEL`; transcribe a T5 without subtitles |
| Jev (TypeSafe decision model) | jevai.org, thejevai.com and docs.typesafe.ai are blocked by this environment's network policy, so the client follows the published wire format (`POST /v1/systemone`, Bearer key, `state` + typed `questions` → `answers`) and is tested against the Jev stand-in in `scripts/fake-fal.ts` | On your Mac: add your key in Settings → Jev (set the API address to the service that issued it), click Test connection, then type a request in New project and check the suggested chips |
| Send to Lanternist | lanternist.app is blocked here, and Lanternist publishes no public API docs, so the button talks to its MCP server (Streamable HTTP, Bearer token) and is tested against the Lanternist stand-in in `scripts/fake-fal.ts`. A manual trial through the Lanternist connector in chat created a real film with matching shots and timings. If Lanternist only offers sign-in (OAuth) for its MCP server, the token won't connect yet | On your Mac: Settings → Lanternist, paste an access token and its MCP address, click Test connection, then Export tab → Send to Lanternist |
| Picture hosting (Fluxtify frames to Lanternist) | No real bucket is reachable here, so uploads, signed links and the live check are tested against the S3 stand-in in `scripts/fake-fal.ts` (:3911) with the real AWS SDK; set_picture on real Lanternist is unverified, and whether Lanternist copies a picture or keeps the link (signed links expire after 1–7 days) is unknown | On your Mac: create a bucket and a key limited to it (e.g. Cloudflare R2), fill in Settings → Picture hosting, Test connection, then Export → Send to Lanternist → "This project's frames" and check the pictures in Lanternist (and again after the link expiry, or set a public address) |
| OmniVoice (local server) | No OmniVoice model/server in this environment (the model needs downloads from blocked hosts); the adapter follows the OpenAI speech API and is tested against `scripts/fake-omnivoice.ts` | On your Mac: start an OmniVoice server, set its address in Settings → OmniVoice, Test connection, then generate narration with an OmniVoice voice |
| Footage APIs (Internet Archive, Wikimedia Commons, Pexels, Pixabay) | All four hosts are blocked by this environment's network policy; parsers follow each API's documented response format and are tested against `scripts/fake-footage.ts` | Assets → Find free footage: search "harbour" on Internet Archive and Wikimedia Commons (no key), add free Pexels/Pixabay keys in Settings and search there; import one item from each and check the licence on the asset and Export → Footage credits |
| Segmentation provider (background removal) | Not integrated (no verified provider contract) | — (templates never require it) |
| Redraw on hardware GPU | Only SwiftShader software WebGPU here (~4 s/frame at 540p) | Run `scripts/clean-worker-check.sh` on a GPU worker |

### Note on one unintended call

While probing the logged-out behaviour of the Agent SDK during §28 work, one diagnostic call
("Say hi as JSON", ~$0.004) was answered using this container's host-managed credentials,
which reach Claude Code through the environment's proxy rather than environment variables.
No further live calls were made; the app's own checks use `accountInfo()` only (no prompt),
and e2e tests use the SDK test double.

## Known limitations

- Product fidelity: a measured colour check runs on every generated take; Claude's product check (Shots → Product check) compares takes with the reference photo for shape, logo, label, colour and proportions. Both are advisory and judged from stills (three samples per video take); the owner still keeps or rejects each take. Tested against the Claude test double only.
- Automated review measures fit, fonts, captions, timing, loudness, decode and text contrast (WCAG ratio
  against the real background on sampled frames; text inside graphics layers is not measured).
  Presenter and subject framing is judged by the Claude critic from stills (tested with the test double
  only). Voiceover pacing is measured from the recordings (speaking rate, mid-line pauses, late starts,
  speech running past a cut); how natural the voice sounds is left to human review.
- The rendered draft is scanned frame by frame (64×36, per 4×4 cell) for one-frame flashes and for
  jumps away from cuts, entrances, captions and footage; calibrated on 34 project renders with no false
  alarms. It catches pops, not every awkward move. Text is judged at 28 px per 1080 on the frame's short
  side (readable on a phone), product screens by the share of the frame width they fill, and videos
  marked "made to loop" by whether the last frame matches the first.
- Sound effects come only from the owner's sound kit (real recordings they upload; nothing is
  synthesised). Each sound's hit is measured on upload and effects are placed so the hit lands on its
  moment (measured in a rendered mix: within 0–8 ms). How the mix sounds is not judged; listen to it.
- Screen demos film the owner's screenshot only (nothing is redrawn): a cursor and a camera that zooms in
  log space, with steps clicked on the screenshot or picked by Claude (Scene tab). Claude's step picking
  is tested against the test double only; check its targets on your own screens.
- Counting numbers show a real value on every frame (formatted like the product, never past a stop,
  never "-0") and are checked against the approved facts: each value, or its change from the stop
  before, must appear there. Lock to the beat (Audio tab) finds the song's drops from its measured
  section energy (each arrival at its peak), uses the first one late enough for the music to start
  with the video, lands it on the payoff (a counter's last value, else the proof, a number or the
  call to action) to the frame, and moves cuts onto beats. The analysis measures the music; it can't
  hear it, so play it back and check the drop feels right.
- Shader effects (mesh gradient, aurora, metaballs, liquid morph, glass lens) are Skia SkSL shaders
  drawn on a WebGL surface (~0.1 s per 1080p frame on software WebGL). The same revision re-renders
  identically on the same machine; across GPUs the pixels may differ very slightly. The glass lens
  refracts only the image chosen for it, not the layers beneath it.
- Redraw export is slow on software WebGPU; production should use GPU workers (routing supports it).
