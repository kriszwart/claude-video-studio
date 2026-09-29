# Graphics backends: Skia and Redraw

Graphics layers are ordinary project data (`kind: "graphics"`, backend, component id +
version, parameters, seed). The compositor places each layer as a canvas inside the
HyperFrames composition; a backend runtime draws it **as a pure function of composition
time** on every `hf-seek`, so any frame can be rendered in any order and re-rendered
identically. Components are versioned (`packages/graphics/src/catalog.ts`); parameters are
edited in the normal inspector.

| Component | Backend | Used by |
| --- | --- | --- |
| `path-diagram@1` | Skia | step diagrams (hand-drawn wobble option) |
| `sketch@1` | Skia | P4 whiteboard illustrations (original line-art set, keyword-matched) |
| `mask-reveal@1` | Skia | product/photo close-up → full reveal, pixels unchanged |
| `type-overlay@1` | Skia | annotation with drawn underline |
| `ribbon@1` | Redraw | P2 motif / brand signature (width taper + colour gradient along path) |
| `glow-backing@1` | Redraw | feathered glow panel behind labels |
| `color-sweep@1` | Redraw | concentric ring sweep |

## Skia (CanvasKit)

- Binding: `canvaskit-wasm@0.42.0`, CPU raster surface (`MakeSWCanvasSurface`): deterministic
  and GPU-independent. Fonts are the project's bundled/uploaded WOFF/WOFF2 files.
- Known binding quirk handled: `Path.makeTrimmed(0, 1)` returns null in 0.42 (identity trim).

## Redraw (WebGPU)

- Package: the owner's licensed release **redraw 1.3.3**, tarball sha256
  `3cb516849efe04076d04b1db4eb4399376a817e860706b502838a7afd757474f`, obtained from the
  authorised `wcandillon/redraw` release artifacts. It is not committed (license forbids
  redistribution); `REDRAW_TARBALL` + `REDRAW_SHA256` point at it and the build bundles it
  with `typegpu@0.12.6` (its only runtime dependency) via esbuild. `scripts/typecheck-redraw.sh`
  typechecks our runtime against the real package.
- Rendering: each layer draws into an `rgba8unorm` storage texture; `copyTextureToBuffer` +
  `mapAsync` is the frame's ready barrier (canvas swap chains lose the device under
  SwiftShader). Output is premultiplied and converted for the 2D canvas.
- Device loss: the runtime rebuilds the device and redraws the frame; a loss that surfaces
  mid-frame (`mapAsync` abort) is retried once on a fresh device. Frames are stateless, so
  the result is identical.
- Performance: no hardware GPU is available here; Chromium's SwiftShader adapter renders
  correctly but slowly (~11 min for a 5 s, 960×540 proof). GPU workers are recommended.

## Capability proofs (PRD §27.4) — `packages/graphics/spike/capability.ts`

Each proof renders a 5 s / 30 fps composition with graphics layers, a supplied font, an image
and music; exports it; then captures stills out of order and repeatedly (and, for Redraw,
after a simulated device loss) and compares them.

| | Skia | Redraw |
| --- | --- | --- |
| Resolution | 1920×1080 | 960×540 (software WebGPU) |
| Export verification (decode, dims, fps, audio, duration, peak) | ✓ | ✓ |
| Loudness | −16.0 LUFS, −1.7 dBTP | −16.0 LUFS, −1.7 dBTP |
| Repeated stills (0.7 s, 3.5 s) byte-identical | ✓ (max diff 0) | ✓ (max diff 0) |
| Out-of-order seeks identical to in-order | ✓ | ✓ |
| Frame after device loss identical | n/a | ✓ (max diff 0) |
| Preview still vs export frame (PSNR) | ~30.7 dB | ~33.5–34.7 dB |
| Render time | 22.8 s | 646 s |

The PSNR gap is H.264 4:2:0 chroma subsampling on sharp text and strokes; the frames are
visually identical. Reports: `artifacts/graphics/{skia,redraw}/report.json` (not committed).

Product use: P2 (Redraw ribbon/rings) and P4 (Skia sketches/diagrams) render in end-to-end
exports (`m2-families`, `m3-talking-head` A18).

## Capability routing

Workers report which backends they can run (`worker_capabilities`). The template gallery
shows a template as needing a backend when no live worker offers it. A render whose document
contains a backend the worker can't run fails with `graphics_unavailable` and a recovery
message — never a blank or silently degraded frame.
