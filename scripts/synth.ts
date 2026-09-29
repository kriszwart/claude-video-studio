/**
 * Tiny deterministic synthesiser for original sample music (no third-party
 * recordings, so the fixtures carry no licensing ambiguity). Output: 48 kHz stereo WAV.
 */
import { writeFileSync } from "node:fs";

const SR = 48000;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

export interface Section {
  name: string;
  bars: number;
  /** 0..1 arrangement density */
  energy: number;
}

export interface SongSpec {
  bpm: number;
  seed: number;
  /** Chord roots (MIDI) per bar, cycled. */
  progression: number[][];
  sections: Section[];
  bassOctave?: number;
}

export function renderSong(spec: SongSpec): { left: Float32Array; right: Float32Array; beats: number[]; sections: { name: string; start: number }[] } {
  const beatSec = 60 / spec.bpm;
  const barSec = beatSec * 4;
  const totalBars = spec.sections.reduce((a, s) => a + s.bars, 0);
  const total = Math.ceil(totalBars * barSec * SR) + SR;
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const rnd = mulberry32(spec.seed);
  const beats: number[] = [];
  const sections: { name: string; start: number }[] = [];

  let bar = 0;
  for (const sec of spec.sections) {
    sections.push({ name: sec.name, start: bar * barSec });
    for (let b = 0; b < sec.bars; b++, bar++) {
      const chord = spec.progression[bar % spec.progression.length]!;
      const t0 = bar * barSec;
      // Pad: detuned sines with slow attack.
      for (const note of chord) {
        const f = midi(note);
        const start = Math.floor(t0 * SR);
        const len = Math.floor(barSec * SR);
        for (let i = 0; i < len; i++) {
          const t = i / SR;
          const env = Math.min(1, t / 0.25) * Math.min(1, (barSec - t) / 0.2);
          const v = (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.003 * t) + 0.25 * Math.sin(2 * Math.PI * f * 2 * t)) * 0.035 * env * (0.6 + 0.4 * sec.energy);
          L[start + i]! += v;
          R[start + i]! += v * 0.92;
        }
      }
      for (let beat = 0; beat < 4; beat++) {
        const tb = t0 + beat * beatSec;
        beats.push(Number(tb.toFixed(4)));
        const s = Math.floor(tb * SR);
        // Kick on every beat when energy > .3, else beats 1 and 3.
        if (sec.energy > 0.3 || beat % 2 === 0) {
          for (let i = 0; i < 0.35 * SR; i++) {
            const t = i / SR;
            const f = 50 + 90 * Math.exp(-t * 30);
            const v = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 9) * 0.5 * (0.5 + 0.5 * sec.energy);
            L[s + i]! += v;
            R[s + i]! += v;
          }
        }
        // Snare/clap on 2 and 4 with energy.
        if (sec.energy > 0.45 && beat % 2 === 1) {
          for (let i = 0; i < 0.18 * SR; i++) {
            const t = i / SR;
            const v = (rnd() * 2 - 1) * Math.exp(-t * 22) * 0.22 * sec.energy;
            L[s + i]! += v * 0.9;
            R[s + i]! += v;
          }
        }
        // Hats on eighths.
        if (sec.energy > 0.2) {
          for (let e = 0; e < 2; e++) {
            const sh = Math.floor((tb + e * beatSec * 0.5) * SR);
            for (let i = 0; i < 0.04 * SR; i++) {
              const t = i / SR;
              const v = (rnd() * 2 - 1) * Math.exp(-t * 90) * 0.07 * sec.energy;
              L[sh + i]! += v;
              R[sh + i]! += v * 0.8;
            }
          }
        }
        // Bass: root on each beat.
        if (sec.energy > 0.25) {
          const f = midi(chord[0]! - 12 * (spec.bassOctave ?? 1));
          for (let i = 0; i < beatSec * 0.9 * SR; i++) {
            const t = i / SR;
            const v = Math.tanh(2 * Math.sin(2 * Math.PI * f * t)) * Math.exp(-t * 3) * 0.12;
            L[s + i]! += v;
            R[s + i]! += v;
          }
        }
      }
      // Arpeggio lead at high energy.
      if (sec.energy > 0.7) {
        for (let k = 0; k < 8; k++) {
          const note = chord[k % chord.length]! + 12;
          const f = midi(note);
          const s = Math.floor((t0 + k * beatSec * 0.5) * SR);
          for (let i = 0; i < beatSec * 0.45 * SR; i++) {
            const t = i / SR;
            const v = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 6) * 0.06;
            L[s + i]! += v * 0.7;
            R[s + i]! += v;
          }
        }
      }
    }
  }
  // Soft clip.
  for (let i = 0; i < total; i++) {
    L[i] = Math.tanh(L[i]! * 1.2) * 0.8;
    R[i] = Math.tanh(R[i]! * 1.2) * 0.8;
  }
  return { left: L, right: R, beats, sections };
}

export function writeWav(path: string, left: Float32Array, right: Float32Array) {
  const n = left.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i]! * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i]! * 32767))), 46 + i * 4);
  }
  writeFileSync(path, buf);
}
