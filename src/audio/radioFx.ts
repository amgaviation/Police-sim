import { createRng } from '../core/rng';
import { CHATTER_DATA, type ChatterData } from './chatterData';
import { glide, safeDisconnect } from './nodes';
import { createAudioStats, type AudioStats } from './sirens';

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
/** Glide of the background bed level (s). */
const BED_TAU = 0.3;
/** Fade of a babble burst that is cut for a newer one (s). */
const CUT_S = 0.03;

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

/** A live babble burst: its source and a cleanup that disconnects every node of it. */
interface Burst {
  readonly src: AudioBufferSourceNode;
  readonly env: GainNode;
  cleanup(): void;
}

export class RadioFx {
  private readonly stats: AudioStats;
  private readonly chatterData: ChatterData;
  private readonly rng = createRng('audio:chatter');
  private readonly bursts: Burst[] = [];
  private bedGain: GainNode | null = null;
  private bedNodes: AudioNode[] = [];
  private bedSources: (AudioBufferSourceNode | OscillatorNode)[] = [];
  /** Requested bed level 0..1 (kept so a level set before unlock applies at attach). */
  private bedLevel = 0;
  private ctx: BaseAudioContext | null = null;
  private out: AudioNode | null = null;
  private noise: AudioBuffer | null = null;
  /** Rotates the noise start offset so consecutive bursts differ (deterministically). */
  private noiseCursor = 0;
  /** Level multiplier (0..1) for the effects scheduled next, e.g. the scan volume for a scanned channel. */
  level = 1;

  constructor(stats: AudioStats = createAudioStats(), chatterData: ChatterData = CHATTER_DATA) {
    this.stats = stats;
    this.chatterData = chatterData;
  }

  /** @internal Attaches the radio bus and the shared noise buffer (engine unlock); builds the babble bed once. */
  attach(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer): void {
    this.ctx = ctx;
    this.out = out;
    this.noise = noise;
    try {
      this.buildBed(ctx, out, noise);
    } catch {
      // never throw from audio
    }
  }

  /** @internal */
  detach(): void {
    for (const src of this.bedSources) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    for (const node of this.bedNodes) safeDisconnect(node);
    this.bedSources = [];
    this.bedNodes = [];
    this.bedGain = null;
    for (const b of this.bursts) b.cleanup();
    this.bursts.length = 0;
    this.stats.chatter = 0;
    this.ctx = null;
    this.out = null;
    this.noise = null;
  }

  /**
   * Unintelligible voice-like babble for `durationS` at `level` (0..1) on the radio bus: looped noise through three
   * formant band-passes summed, amplitude-modulated by a square-ish syllable envelope (rate drawn per burst from
   * `syllableHz`), band-limited to `bandHz`; at most `maxBursts` at once (the oldest is cut).
   */
  chatter(durationS: number, level: number): void {
    this.run((t) => {
      const lvl = clampLevel(level) * this.chatterData.burstLevel;
      if (lvl <= 0) return;
      this.burst(t, clampDuration(durationS), lvl);
    });
  }

  /** Background babble bed level 0..1 (x `bedLevel`); glides (tau 0.3 s). */
  setBed(level: number): void {
    this.bedLevel = clampLevel(level);
    this.applyBed();
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

  private applyBed(): void {
    const ctx = this.ctx;
    const gain = this.bedGain;
    if (!ctx || !gain) return;
    try {
      glide(gain.gain, this.bedLevel * this.chatterData.bedLevel, ctx.currentTime, BED_TAU);
    } catch {
      // never throw from audio
    }
  }

  /** Babble chain: noise -> 3 formant band-passes -> syllable gain (square LFO) -> band-pass -> `dest`. Returns its nodes. */
  private babble(ctx: BaseAudioContext, noise: AudioBuffer, dest: AudioNode, offset: number): { src: AudioBufferSourceNode; lfo: OscillatorNode; nodes: AudioNode[] } {
    const d = this.chatterData;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const syllable = ctx.createGain();
    syllable.gain.value = 0.5;
    const nodes: AudioNode[] = [src, syllable];
    for (const hz of d.formantsHz) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = hz;
      bp.Q.value = d.formantQ;
      src.connect(bp);
      bp.connect(syllable);
      nodes.push(bp);
    }
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = this.rng.nextFloat(d.syllableHz[0], d.syllableHz[1]);
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth);
    depth.connect(syllable.gain);
    // Band limit: one band-pass spanning bandHz (centre = geometric mean, Q = centre / width).
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    const centre = Math.sqrt(d.bandHz[0] * d.bandHz[1]);
    band.frequency.value = centre;
    band.Q.value = centre / Math.max(1, d.bandHz[1] - d.bandHz[0]);
    syllable.connect(band);
    band.connect(dest);
    nodes.push(lfo, depth, band);
    const dur = noise.duration;
    src.start(0, dur > 0 ? offset * dur : 0);
    lfo.start();
    return { src, lfo, nodes };
  }

  private buildBed(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer): void {
    if (this.bedGain) return;
    const gain = ctx.createGain();
    gain.gain.value = this.bedLevel * this.chatterData.bedLevel;
    gain.connect(out);
    const chain = this.babble(ctx, noise, gain, 0.61);
    this.bedGain = gain;
    this.bedNodes = [gain, ...chain.nodes];
    this.bedSources = [chain.src, chain.lfo];
  }

  private burst(t: number, d: number, level: number): void {
    const ctx = this.ctx;
    const out = this.out;
    const noise = this.noise;
    if (!ctx || !out || !noise) return;
    const max = this.chatterData.maxBursts;
    while (this.bursts.length >= max) this.cut(this.bursts.shift(), t);
    const env = this.envelope(ctx, t, d, level, false);
    env.connect(out);
    this.noiseCursor = (this.noiseCursor + 0.137) % 1;
    const chain = this.babble(ctx, noise, env, this.noiseCursor);
    const nodes = chain.nodes;
    let done = false;
    const burst: Burst = {
      src: chain.src,
      env,
      cleanup: () => {
        if (done) return;
        done = true;
        for (const n of nodes) safeDisconnect(n);
        safeDisconnect(env);
        const i = this.bursts.indexOf(burst);
        if (i >= 0) this.bursts.splice(i, 1);
        this.stats.chatter = this.bursts.length;
      },
    };
    chain.src.onended = () => burst.cleanup();
    chain.lfo.stop(t + d + 0.01);
    chain.src.stop(t + d + 0.01);
    this.bursts.push(burst);
    this.stats.chatter = this.bursts.length;
  }

  /** Fades a burst out quickly and stops it (it is already removed from the live list). */
  private cut(burst: Burst | undefined, t: number): void {
    if (!burst) return;
    try {
      burst.env.gain.cancelScheduledValues(t);
      burst.env.gain.setValueAtTime(0, t + CUT_S);
      burst.src.stop(t + CUT_S);
    } catch {
      // already stopped
    }
    this.stats.chatter = this.bursts.length;
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
