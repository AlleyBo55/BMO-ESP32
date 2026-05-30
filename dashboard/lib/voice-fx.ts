/**
 * BMO "robotic radio" voice effect — DSP post-processing for TTS audio.
 *
 * The TTS model gives us a clean, full-range human-sounding voice. BMO's
 * Adventure Time voice has a distinct *lo-fi handheld-speaker / radio*
 * quality on top of the tone: band-limited (tinny, no deep bass or airy
 * highs), with a subtle digital/robotic grain. No amount of prompting makes
 * the TTS model add that — it's an acoustic characteristic, not a speaking
 * style — so we apply it ourselves to the raw PCM16 samples.
 *
 * The chain (in order), all on PCM16 mono @ 24 kHz:
 *   1. High-pass  — strips deep bass so it sounds like a small speaker.
 *   2. Low-pass   — strips airy highs (the "AM radio / telephone" band).
 *   3. Sample-and-hold decimation — drops the effective sample rate a little,
 *      adding the gritty digital/robotic aliasing that reads as "toy robot".
 *   4. Bitcrush   — quantizes to fewer bits for a touch more digital edge.
 *   5. Soft drive — gentle saturation for radio "rasp", then output gain.
 *   6. Dry/wet mix — blends a little of the clean voice back so it stays
 *      intelligible for a child.
 *
 * Everything is tuned to be *characterful but still clearly understandable*.
 * Tunable per deploy via env (see {@link radioFxOptionsFromEnv}); set
 * `BMO_VOICE_FX=off` to bypass entirely.
 *
 * Streaming-safe: {@link RadioVoiceFx} keeps biquad + decimator state across
 * chunks, and {@link applyRadioFx} wraps an async PCM stream transparently so
 * both the streaming device routes and the buffered simulator route share one
 * implementation.
 */

import { Buffer } from 'node:buffer';

const DEFAULT_SAMPLE_RATE = 24_000;

export interface RadioFxOptions {
  /** PCM sample rate in Hz. Must match the audio. Default 24000. */
  sampleRate: number;
  /** High-pass corner (Hz): everything well below this is removed. */
  highpassHz: number;
  /** Low-pass corner (Hz): everything well above this is removed. */
  lowpassHz: number;
  /** Biquad resonance for both filters. ~0.707 is flat (no peak). */
  q: number;
  /** Sample-and-hold factor; 1 = off, 2 = hold every 2nd sample, etc. */
  decimate: number;
  /** Bitcrush target bit depth (1..16). 16 = effectively off. */
  bits: number;
  /** Pre-saturation drive (>= 1 adds rasp). */
  drive: number;
  /** Output makeup gain after the chain. */
  outGain: number;
  /** Dry/wet blend, 0 = bypass, 1 = fully processed. */
  mix: number;
}

/** Characterful-but-intelligible defaults tuned for BMO. */
export const BMO_RADIO_FX_DEFAULTS: RadioFxOptions = {
  sampleRate: DEFAULT_SAMPLE_RATE,
  highpassHz: 520,
  lowpassHz: 3600,
  q: 0.9,
  decimate: 2,
  bits: 10,
  drive: 1.6,
  outGain: 1.05,
  mix: 0.85,
};

/** Direct-Form-I biquad coefficients (already normalized by a0). */
interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function highpassCoeffs(fs: number, f0: number, q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cw) / 2) / a0,
    b1: (-(1 + cw)) / a0,
    b2: ((1 + cw) / 2) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

function lowpassCoeffs(fs: number, f0: number, q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cw) / 2) / a0,
    b1: (1 - cw) / a0,
    b2: ((1 - cw) / 2) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** A single stateful Direct-Form-I biquad section. */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(private readonly c: BiquadCoeffs) {}

  step(x: number): number {
    const { b0, b1, b2, a1, a2 } = this.c;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Soft saturation; smoothly clips toward ±1 so drive adds rasp not buzz. */
function softClip(x: number, drive: number): number {
  return Math.tanh(x * drive) / Math.tanh(drive);
}

/**
 * Stateful "robotic radio" processor. Feed it PCM16 byte chunks in order via
 * {@link process}; the filter/decimator state carries across calls so a
 * streamed signal sounds identical to a buffered one. Call {@link flush} at
 * the end to emit any half-sample byte held back at a chunk boundary.
 */
export class RadioVoiceFx {
  private readonly opts: RadioFxOptions;
  private readonly hp: Biquad;
  private readonly lp: Biquad;
  private readonly bitStep: number;
  /** Sample-and-hold state. */
  private holdCounter = 0;
  private heldSample = 0;
  /** Carries a single leftover byte when a chunk ends mid-sample. */
  private leftover: number | null = null;

  constructor(options?: Partial<RadioFxOptions>) {
    this.opts = { ...BMO_RADIO_FX_DEFAULTS, ...options };
    this.hp = new Biquad(highpassCoeffs(this.opts.sampleRate, this.opts.highpassHz, this.opts.q));
    this.lp = new Biquad(lowpassCoeffs(this.opts.sampleRate, this.opts.lowpassHz, this.opts.q));
    const bits = Math.max(1, Math.min(16, Math.round(this.opts.bits)));
    this.bitStep = 2 / Math.pow(2, bits); // quantization step on a -1..1 signal
  }

  /** Processes one float sample (-1..1) through the full chain. */
  private stepSample(input: number): number {
    const dry = input;

    // 1+2: band-pass via cascaded high-pass then low-pass.
    let s = this.hp.step(input);
    s = this.lp.step(s);

    // 3: sample-and-hold decimation (the robotic aliasing).
    const dec = Math.max(1, Math.round(this.opts.decimate));
    if (this.holdCounter % dec === 0) {
      this.heldSample = s;
    }
    this.holdCounter += 1;
    s = this.heldSample;

    // 4: bitcrush — quantize to a coarse grid.
    if (this.bitStep > 0) {
      s = Math.round(s / this.bitStep) * this.bitStep;
    }

    // 5: soft drive + makeup gain.
    s = softClip(s, this.opts.drive) * this.opts.outGain;

    // 6: dry/wet mix.
    const out = this.opts.mix * s + (1 - this.opts.mix) * dry;

    // Hard safety clamp to valid range.
    if (out > 1) return 1;
    if (out < -1) return -1;
    return out;
  }

  /**
   * Processes a PCM16-LE chunk and returns the processed PCM16-LE bytes. If
   * the chunk has an odd length (a sample split across a chunk boundary), the
   * trailing byte is held and prepended to the next chunk.
   */
  process(chunk: Buffer): Buffer {
    let buf = chunk;
    if (this.leftover !== null) {
      buf = Buffer.concat([Buffer.from([this.leftover]), chunk]);
      this.leftover = null;
    }
    const sampleCount = Math.floor(buf.length / 2);
    if (buf.length % 2 === 1) {
      this.leftover = buf[buf.length - 1] ?? null;
    }

    const out = Buffer.allocUnsafe(sampleCount * 2);
    for (let i = 0; i < sampleCount; i++) {
      const raw = buf.readInt16LE(i * 2);
      const processed = this.stepSample(raw / 32768);
      let v = Math.round(processed * 32767);
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      out.writeInt16LE(v, i * 2);
    }
    return out;
  }

  /** Emits nothing meaningful for PCM16 (a single leftover byte is dropped). */
  flush(): Buffer {
    this.leftover = null;
    return Buffer.alloc(0);
  }
}

/** True unless `BMO_VOICE_FX` is explicitly set to `off` / `0` / `false`. */
export function radioFxEnabled(): boolean {
  const v = process.env.BMO_VOICE_FX;
  if (typeof v !== 'string') return true;
  const t = v.trim().toLowerCase();
  return !(t === 'off' || t === '0' || t === 'false' || t === 'no');
}

/**
 * Reads optional per-deploy overrides from the environment so the effect can
 * be dialed in without a redeploy of code. Any unset/invalid var falls back
 * to {@link BMO_RADIO_FX_DEFAULTS}.
 */
export function radioFxOptionsFromEnv(sampleRate = DEFAULT_SAMPLE_RATE): Partial<RadioFxOptions> {
  const num = (name: string): number | undefined => {
    const raw = process.env[name];
    if (typeof raw !== 'string') return undefined;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const opts: Partial<RadioFxOptions> = { sampleRate };
  const map: Array<[keyof RadioFxOptions, string]> = [
    ['highpassHz', 'BMO_VOICE_FX_HIGHPASS'],
    ['lowpassHz', 'BMO_VOICE_FX_LOWPASS'],
    ['q', 'BMO_VOICE_FX_Q'],
    ['decimate', 'BMO_VOICE_FX_DECIMATE'],
    ['bits', 'BMO_VOICE_FX_BITS'],
    ['drive', 'BMO_VOICE_FX_DRIVE'],
    ['outGain', 'BMO_VOICE_FX_GAIN'],
    ['mix', 'BMO_VOICE_FX_MIX'],
  ];
  for (const [key, envName] of map) {
    const v = num(envName);
    if (v !== undefined) opts[key] = v;
  }
  return opts;
}

/**
 * Wraps an async PCM16 stream, applying the robotic-radio effect to every
 * chunk while preserving streaming semantics (and honoring the `BMO_VOICE_FX`
 * toggle). If the effect is disabled the source is passed through untouched.
 */
export async function* applyRadioFx(
  source: AsyncIterable<Buffer>,
  options?: Partial<RadioFxOptions>,
): AsyncIterable<Buffer> {
  if (!radioFxEnabled()) {
    yield* source;
    return;
  }
  const fx = new RadioVoiceFx({ ...radioFxOptionsFromEnv(options?.sampleRate), ...options });
  for await (const chunk of source) {
    const processed = fx.process(chunk);
    if (processed.length > 0) yield processed;
  }
  const tail = fx.flush();
  if (tail.length > 0) yield tail;
}
