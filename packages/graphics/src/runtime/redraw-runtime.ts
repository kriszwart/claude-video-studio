/**
 * Redraw (WebGPU) graphics runtime, executed inside a compiled composition page.
 * Each layer renders into a plain rgba8unorm GPUTexture (canvas swap chains are not
 * used: they lose the device under software WebGPU). On every "hf-seek" the frame is
 * recorded as a pure function of time, submitted, copied to a buffer and awaited with
 * mapAsync — the resolved promise is the ready barrier — then painted into a 2D canvas.
 */
import { BlendMode, Circle, createLibrary, Feather, fitPath, GradientAlongPath, Paint, RadialGradient, RoundedRect, SineTaper, SingleStrokeBrush, type Canvas as RCanvas } from "redraw";

interface Spec {
  id: string;
  /** Frame pixels per 1080p pixel (min side / 1080); px parameters are defined at 1080p. */
  unit?: number;
  backend: string;
  component: string;
  version: number;
  params: Record<string, number | string | boolean>;
  startSec: number;
  durationSec: number;
  width: number;
  height: number;
  seed: number;
}

interface Layer {
  spec: Spec;
  target: GPUTexture;
  rc: RCanvas;
  ctx2d: CanvasRenderingContext2D;
  readBuffer: GPUBuffer;
  bytesPerRow: number;
  lastT: number | null;
}

type W = typeof window & {
  __hf?: { buildReady?: Record<string, Promise<unknown>> };
  __vsGraphics?: Spec[];
  __vsRedrawReport?: { layers: number; frames: number; errors: string[]; adapter: string; lost: number };
};
const w = window as W;
const report = (w.__vsRedrawReport = { layers: 0, frames: 0, errors: [] as string[], adapter: "", lost: 0 });

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const colors = (s: unknown, fb: string[]) => {
  const list = String(s ?? "").split(",").map((c) => c.trim()).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  return list.length >= 2 ? list : fb;
};

const PATHS: Record<string, string> = {
  wave: "M 0 60 C 20 0, 40 120, 60 60 S 100 0, 120 60 S 160 120, 180 60",
  loop: "M 0 80 C 40 80, 60 0, 90 20 S 110 110, 80 90 S 60 30, 120 40 S 170 80, 180 70",
  swoosh: "M 0 100 C 50 100, 70 20, 120 30 S 170 70, 180 10",
  circle: "M 90 10 A 50 50 0 1 1 89.9 10",
};

/** ribbon v1: variable-width stroke with a gradient along its path and a glow. */
function ribbon(L: Layer, t: number) {
  const p = L.spec.params;
  const { width: W0, height: H0 } = L.spec;
  const pad = Math.min(W0, H0) * 0.12;
  const path = fitPath(PATHS[String(p.path)] ?? PATHS.wave!, { x: pad, y: pad, width: W0 - pad * 2, height: H0 - pad * 2 });
  const grad = new GradientAlongPath(colors(p.colors, ["#3FCEBC", "#5F96E7", "#DE589F", "#FAEC54"]), { period: 4000, colorSpace: "oklab" });
  grad.time = t * 1000;
  const unit = Math.min(W0, H0) / 1080;
  const taper = new SineTaper({ baseWidth: Number(p.width ?? 60) * unit * 1.6, exponent: 0.5 });
  const k = ease(clamp01(t / Math.max(0.05, Number(p.drawSec ?? 1.6))));
  if (k <= 0) return;
  const seg = k >= 1 ? path : path.segment(0, Math.max(0.001, k));
  const glowSigma = Number(p.glow ?? 24) * unit;
  // SingleStrokeBrush evaluates the width law and the along-path gradient over the drawn
  // path (Paint.setStroke(binding) does not), matching Redraw's own plugin-free examples.
  if (glowSigma > 0) {
    const glow = new SingleStrokeBrush(taper).addShader(grad).setFeather(Feather.glow(glowSigma));
    glow.blendMode = BlendMode.Screen;
    L.rc.drawPath(seg, glow);
  }
  L.rc.drawPath(seg, new SingleStrokeBrush(taper).addShader(grad));
}

/** glow-backing v1: rounded panel with a feathered glow (does not sample content behind it). */
function glowBacking(L: Layer, t: number) {
  const p = L.spec.params;
  const { width: W0, height: H0 } = L.spec;
  const feather = Number(p.feather ?? 32) * (Math.min(W0, H0) / 400);
  const k = ease(clamp01(t / 0.5));
  // Pixel sizes are defined at 1080p and scaled with the frame, so previews match exports.
  const u = Number(L.spec.unit ?? 1);
  const inset = feather + 4 * u;
  const hw = ((W0 - inset * 2) / 2) * (0.85 + 0.15 * k);
  const hh = (H0 - inset * 2) / 2;
  const geo = new RoundedRect([W0 / 2, H0 / 2], [hw, hh], Math.min(hh, 28 * u));
  const glow = new Paint().setColor(String(p.glowColor ?? "#8b8fff")).setFeather(Feather.outer(feather));
  L.rc.draw(geo, glow);
  const panel = new Paint().setColor(String(p.color ?? "#111827"));
  L.rc.draw(geo, panel);
}

/** color-sweep v1: concentric rings with a sweeping radial colour band. */
function colorSweep(L: Layer, t: number) {
  const p = L.spec.params;
  const { width: W0, height: H0 } = L.spec;
  const n = Math.max(1, Math.min(12, Math.round(Number(p.rings ?? 5))));
  const cols = colors(p.colors, ["#8b8fff", "#22d3ee", "#f59e0b"]);
  const sweep = clamp01(t / Math.max(0.1, Number(p.sweepSec ?? 2)));
  const R = Math.min(W0, H0) * 0.46;
  for (let i = n; i >= 1; i--) {
    const r = (R * i) / n;
    const phase = clamp01(sweep * 1.4 - (i - 1) / n);
    if (phase <= 0) continue;
    const grad = new RadialGradient([cols[i % cols.length]!, cols[(i + 1) % cols.length]!], { center: [W0 / 2, H0 / 2], radius: r });
    const ring = new Paint().addShader(grad).setStroke(Math.max(2, (R / n) * 0.35 * ease(phase))).setFeather(Feather.glow(6));
    L.rc.draw(new Circle([W0 / 2, H0 / 2], r * (0.9 + 0.1 * ease(phase))), ring);
  }
}

const COMPONENTS: Record<string, (L: Layer, t: number) => void> = { "ribbon@1": ribbon, "glow-backing@1": glowBacking, "color-sweep@1": colorSweep };

let device: GPUDevice | null = null;
const layers: Layer[] = [];

async function acquireDevice(): Promise<GPUDevice> {
  if (!("gpu" in navigator)) throw new Error("WebGPU is not available in this browser (navigator.gpu missing).");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter is available.");
  const info = (adapter as GPUAdapter & { info?: { vendor?: string; architecture?: string; description?: string } }).info;
  report.adapter = `${info?.vendor ?? "?"} ${info?.architecture ?? ""} ${info?.description ?? ""}`.trim();
  const d = await adapter.requestDevice({
    requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: (adapter.limits as GPUSupportedLimits & { maxBufferSize: number }).maxBufferSize },
  });
  d.lost.then((l) => {
    report.lost++;
    report.errors.push(`device lost: ${l.reason} ${l.message}`);
    // Only clear the current device; a stale loss must not clobber a rebuilt one.
    if (device === d) device = null;
  });
  return d;
}

async function setup() {
  const specs = (w.__vsGraphics ?? []).filter((s) => s.backend === "redraw");
  if (!specs.length) return;
  await rebuild(specs);
}

async function rebuild(specs: Spec[]) {
  layers.length = 0;
  device = await acquireDevice();
  const lib = createLibrary(device, [], { maxDrawingsPerTile: 64 });
  for (const spec of specs) {
    if (!COMPONENTS[`${spec.component}@${spec.version}`]) throw new Error(`Unsupported Redraw component ${spec.component} v${spec.version}`);
    const el = document.getElementById(`gfx-${spec.id}`) as HTMLCanvasElement | null;
    if (!el) throw new Error(`Missing canvas for ${spec.id}`);
    const ctx2d = el.getContext("2d");
    if (!ctx2d) throw new Error("2D context unavailable");
    const target = device.createTexture({ size: [spec.width, spec.height], format: "rgba8unorm", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING });
    const bytesPerRow = Math.ceil((spec.width * 4) / 256) * 256;
    const readBuffer = device.createBuffer({ size: bytesPerRow * spec.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    layers.push({ spec, target, rc: lib.makeCanvas(target), ctx2d, readBuffer, bytesPerRow, lastT: null });
  }
  report.layers = layers.length;
}

async function renderLayer(L: Layer, t: number) {
  const d = device!;
  L.rc.fillColor([0, 0, 0, 0]);
  COMPONENTS[`${L.spec.component}@${L.spec.version}`]!(L, t);
  L.rc.render();
  const enc = d.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: L.target }, { buffer: L.readBuffer, bytesPerRow: L.bytesPerRow }, [L.spec.width, L.spec.height]);
  d.queue.submit([enc.finish()]);
  // Resolves only after every earlier submission (the draw) has completed: the ready barrier.
  await L.readBuffer.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(L.readBuffer.getMappedRange());
  const img = L.ctx2d.createImageData(L.spec.width, L.spec.height);
  const { width: W0, height: H0 } = L.spec;
  for (let y = 0; y < H0; y++) {
    const row = src.subarray(y * L.bytesPerRow, y * L.bytesPerRow + W0 * 4);
    // Redraw output is premultiplied; ImageData is straight alpha.
    for (let x = 0; x < W0; x++) {
      const i = x * 4;
      const a = row[i + 3]!;
      const o = (y * W0 + x) * 4;
      if (a === 0) {
        img.data[o] = img.data[o + 1] = img.data[o + 2] = img.data[o + 3] = 0;
      } else {
        img.data[o] = Math.min(255, Math.round((row[i]! * 255) / a));
        img.data[o + 1] = Math.min(255, Math.round((row[i + 1]! * 255) / a));
        img.data[o + 2] = Math.min(255, Math.round((row[i + 2]! * 255) / a));
        img.data[o + 3] = a;
      }
    }
  }
  L.readBuffer.unmap();
  L.ctx2d.putImageData(img, 0, 0);
}

async function drawOnce(time: number) {
  if (!device) {
    // Device loss: reinitialise from project data (frames are stateless) and redraw.
    await rebuild(layers.map((l) => l.spec));
  }
  for (const L of layers) {
    const t = time - L.spec.startSec;
    // Off-screen (the layer's scene clip is hidden): skip the GPU work entirely.
    if (t < -1e-6 || t > L.spec.durationSec + 1e-6) continue;
    const tt = Math.max(0, Math.min(t, L.spec.durationSec));
    if (L.lastT === tt) continue;
    await renderLayer(L, tt);
    L.lastT = tt;
    report.frames++;
  }
}

function isDeviceLoss(e: unknown): boolean {
  return device === null || (e instanceof DOMException && (e.name === "AbortError" || e.name === "OperationError")) || /device.*lost|lost.*device/i.test(String(e));
}

/** Draw a frame; a device lost mid-frame (the loss promise may not have settled yet) is rebuilt once and the frame redrawn. */
async function drawAll(time: number) {
  try {
    await drawOnce(time);
  } catch (e) {
    if (!isDeviceLoss(e)) throw e;
    report.errors.push(`recovered from device loss while drawing t=${time.toFixed(3)}: ${String(e).slice(0, 160)}`);
    device = null;
    await drawOnce(time);
  }
}

w.__hf = w.__hf || {};
w.__hf.buildReady = w.__hf.buildReady || {};
const ready = setup();
w.__hf.buildReady["vs-redraw"] = ready;
let chain: Promise<unknown> = ready;
window.addEventListener("hf-seek", (e: Event) => {
  const d = (e as CustomEvent<{ time: number; waitUntil?: (p: Promise<unknown>) => void }>).detail;
  // Serialise seeks: a layer's readback buffer can only be mapped once at a time.
  const p = (chain = chain.then(() => drawAll(d.time)).catch((err) => {
    report.errors.push(String(err));
    throw err;
  }));
  d.waitUntil?.(p);
});
// Preview (no hf-seek yet): draw frame 0 once ready, inside the same serial chain.
chain = chain.then(() => drawAll(0)).catch((e) => report.errors.push(String(e)));

/** Test hook: simulate device loss (A29). */
(w as unknown as { __vsLoseRedrawDevice?: () => void }).__vsLoseRedrawDevice = () => device?.destroy();
