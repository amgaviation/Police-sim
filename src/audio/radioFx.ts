import { safeDisconnect } from './nodes';

/**
 * Non-positional radio effects on the radio bus (design §10.3). Each call schedules a few
 * short-lived sources (event-driven, never per frame) and cleans them up when they end.
 * Without an unlocked context every method is a no-op; nothing here ever throws.
 */

export type AlertToneKind = 'hit' | 'offer' | 'statusCheck';

/** Longest effect a caller may request (s). */
const MAX_DURATION_S = 10;
/** Envelope edge for gated sounds (s), avoids clicks. */
const EDGE_S = 0.005;
const TONE_LEVEL = 0.22;

type FilterSpec = { readonly type: BiquadFilterType; readonly hz: number; readonly q: number } | null;

const STATIC_FILTER: FilterSpec = { type: 'bandpass', hz: 2200, q: 0.6 };
const CLICK_FILTER: FilterSpec = { type: 'highpass', hz: 1500, q: 0.7 };
const SQUELCH_FILTER: FilterSpec = { type: 'bandpass', hz: 3000, q: 0.8 };

function clampDuration(d: number): number {
  return Number.isFinite(d) ? Math.min(MAX_DURATION_S, Math.max(0.02, d)) : 0.02;
}

function clampLevel(l: number): number {
  return Number.isFinite(l) ? Math.min(1, Math.max(0, l)) : 0;
}

export class RadioFx {
  private ctx: BaseAudioContext | null = null;
  private out: AudioNode | null = null;
  private noise: AudioBuffer | null = null;
  /** Rotates the noise start offset so consecutive bursts differ (deterministically). */
  private noiseCursor = 0;
  /** Level multiplier (0..1) for the effects scheduled next, e.g. the scan volume for a scanned channel. */
  level = 1;

  /** @internal Attaches the radio bus and the shared noise buffer (engine unlock). */
  attach(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer): void {
    this.ctx = ctx;
    this.out = out;
    this.noise = noise;
  }

  /** @internal */
  detach(): void {
    this.ctx = null;
    this.out = null;
    this.noise = null;
  }

  /** Mic key-up: 15 ms click followed by 120 ms of static. */
  keyUp(): void {
    this.run((t) => {
      this.noiseBurst(t, 0.015, 0.5, CLICK_FILTER, false);
      this.noiseBurst(t + 0.015, 0.12, 0.12, STATIC_FILTER, false);
    });
  }

  /** End-of-transmission squelch tail: bandpassed noise burst with a fast decay. */
  squelchTail(): void {
    this.run((t) => this.noiseBurst(t, 0.25, 0.35, SQUELCH_FILTER, true));
  }

  /** Steady static for `durationS` at `level` (0..1). */
  static(durationS: number, level: number): void {
    this.run((t) => this.noiseBurst(t, clampDuration(durationS), clampLevel(level), STATIC_FILTER, false));
  }

  /** Stepped-on transmission: two beating sines (1000 + 1037 Hz) over static. */
  heterodyne(durationS: number): void {
    this.run((t) => {
      const d = clampDuration(durationS);
      this.tone(t, d, 1000, 0.16);
      this.tone(t, d, 1037, 0.16);
      this.noiseBurst(t, d, 0.12, STATIC_FILTER, false);
    });
  }

  /** Priority traffic alert: 6 x 125 ms alternating 1400 / 850 Hz. */
  priorityTone(): void {
    this.run((t) => {
      for (let i = 0; i < 6; i++) this.tone(t + i * 0.125, 0.125, i % 2 === 0 ? 1400 : 850, TONE_LEVEL);
    });
  }

  /** MDT/radio alert beeps: hit (3 x 80 ms 1 kHz), offer (900 then 1200 Hz), statusCheck (2 x 150 ms 1.4 kHz). */
  alertTone(kind: AlertToneKind): void {
    this.run((t) => {
      switch (kind) {
        case 'hit':
          for (let i = 0; i < 3; i++) this.tone(t + i * 0.16, 0.08, 1000, TONE_LEVEL);
          break;
        case 'offer':
          this.tone(t, 0.15, 900, TONE_LEVEL);
          this.tone(t + 0.15, 0.15, 1200, TONE_LEVEL);
          break;
        case 'statusCheck':
          this.tone(t, 0.15, 1400, TONE_LEVEL);
          this.tone(t + 0.25, 0.15, 1400, TONE_LEVEL);
          break;
      }
    });
  }

  private run(fn: (t: number) => void): void {
    const ctx = this.ctx;
    if (!ctx || !this.out) return;
    try {
      fn(ctx.currentTime + 0.01);
    } catch {
      // never throw from audio
    }
  }

  private envelope(ctx: BaseAudioContext, t: number, d: number, level: number, decay: boolean): GainNode {
    const env = ctx.createGain();
    const g = env.gain;
    level *= clampLevel(this.level);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(level, t + Math.min(EDGE_S, d / 4));
    if (decay) {
      g.exponentialRampToValueAtTime(0.0001, t + d);
    } else {
      g.setValueAtTime(level, t + Math.max(d - EDGE_S, d / 2));
      g.linearRampToValueAtTime(0, t + d);
    }
    return env;
  }

  private noiseBurst(t: number, d: number, level: number, filter: FilterSpec, decay: boolean): void {
    const ctx = this.ctx;
    const out = this.out;
    if (!ctx || !out || !this.noise || level <= 0) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const env = this.envelope(ctx, t, d, level, decay);
    let filterNode: BiquadFilterNode | null = null;
    if (filter) {
      filterNode = ctx.createBiquadFilter();
      filterNode.type = filter.type;
      filterNode.frequency.value = filter.hz;
      filterNode.Q.value = filter.q;
      src.connect(filterNode);
      filterNode.connect(env);
    } else {
      src.connect(env);
    }
    env.connect(out);
    const duration = this.noise.duration;
    this.noiseCursor = (this.noiseCursor + 0.137) % 1;
    src.onended = () => {
      safeDisconnect(src);
      if (filterNode) safeDisconnect(filterNode);
      safeDisconnect(env);
    };
    src.start(t, duration > 0 ? this.noiseCursor * duration : 0);
    src.stop(t + d + 0.01);
  }

  private tone(t: number, d: number, hz: number, level: number): void {
    const ctx = this.ctx;
    const out = this.out;
    if (!ctx || !out) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = hz;
    const env = this.envelope(ctx, t, d, level, false);
    osc.connect(env);
    env.connect(out);
    osc.onended = () => {
      safeDisconnect(osc);
      safeDisconnect(env);
    };
    osc.start(t);
    osc.stop(t + d + 0.01);
  }
}
