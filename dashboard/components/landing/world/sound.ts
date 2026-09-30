/**
 * Tiny opt-in chiptune bleeps, synthesised with WebAudio (no audio files).
 * Off by default; the AudioContext is only created when the visitor turns
 * sound on, which is also the user gesture browsers require to unlock audio.
 */

export type Cue =
  | 'boot'
  | 'tap'
  | 'listen'
  | 'think'
  | 'talk'
  | 'laugh'
  | 'quest'
  | 'mood';

export interface Bleeper {
  isEnabled(): boolean;
  setEnabled(on: boolean): void;
  play(cue: Cue, text?: string): void;
  dispose(): void;
}

type AudioContextCtor = new () => AudioContext;

export function createBleeper(): Bleeper {
  let ctx: AudioContext | null = null;
  let out: GainNode | null = null;
  let enabled = false;

  function ensure(): AudioContext | null {
    if (ctx) return ctx;
    const w = window as Window & { webkitAudioContext?: AudioContextCtor };
    const Ctor: AudioContextCtor | undefined = window.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    out = ctx.createGain();
    out.gain.value = 0.8;
    const soften = ctx.createBiquadFilter();
    soften.type = 'lowpass';
    soften.frequency.value = 3400;
    out.connect(soften).connect(ctx.destination);
    return ctx;
  }

  function tone(
    freq: number,
    at: number,
    dur: number,
    type: OscillatorType,
    gain: number,
    glideTo?: number,
  ): void {
    if (!ctx || !out) return;
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    }
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(env).connect(out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  function arpeggio(notes: readonly number[], step: number, dur: number, gain: number): void {
    notes.forEach((f, i) => tone(f, i * step, dur, 'square', gain));
  }

  return {
    isEnabled: () => enabled,
    setEnabled(on: boolean): void {
      enabled = on;
      if (on) void ensure()?.resume();
      else void ctx?.suspend();
    },
    play(cue: Cue, text = ''): void {
      if (!enabled || !ensure()) return;
      switch (cue) {
        case 'boot':
          arpeggio([523, 659, 784, 1047], 0.075, 0.07, 0.035);
          break;
        case 'tap':
          tone(880, 0, 0.09, 'square', 0.045, 1320);
          break;
        case 'listen':
          tone(440, 0, 0.18, 'sine', 0.07, 660);
          tone(660, 0.16, 0.1, 'triangle', 0.05);
          break;
        case 'think':
          tone(620, 0, 0.06, 'triangle', 0.06);
          tone(930, 0.09, 0.06, 'triangle', 0.06);
          break;
        case 'talk': {
          // Babble: one bleep per few characters, like a tiny game character.
          const count = Math.max(4, Math.min(18, Math.round(text.length / 4)));
          for (let i = 0; i < count; i++) {
            tone(360 + Math.random() * 360, i * 0.085, 0.05, 'square', 0.03);
          }
          break;
        }
        case 'laugh':
          arpeggio([988, 880, 784, 698, 659], 0.07, 0.06, 0.035);
          break;
        case 'quest':
          arpeggio([1047, 1319, 1568, 2093], 0.06, 0.09, 0.03);
          tone(1568, 0.3, 0.35, 'triangle', 0.04);
          break;
        case 'mood':
          tone(740, 0, 0.05, 'triangle', 0.04);
          break;
      }
    },
    dispose(): void {
      void ctx?.close();
      ctx = null;
      out = null;
    },
  };
}
