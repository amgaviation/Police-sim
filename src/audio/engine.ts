import { log } from '../core/log';
import { SIREN_DATA, type SirenData } from './data';
import { fillNoise, glide, safeDisconnect, setListenerPose, swallow, type ListenerState } from './nodes';
import { RadioFx } from './radioFx';
import { SirenBank, type AudioStats } from './sirens';

/**
 * The game's single Web Audio context (design §10.1): created lazily by `unlock()` from a
 * user gesture, graph `master` <- `sfx` bus (sirens) + `radio` bus (radio FX). Without an
 * AudioContext constructor (node, old browsers) `available` is false and every method is a
 * no-op. No method ever throws.
 */

export interface AudioVolumes {
  master: number;
  sfx: number;
  radio: number;
}

export interface AudioEngineOptions {
  /** Context constructor seam (tests inject a fake); null disables audio. Default: the browser's. */
  contextFactory?: (() => AudioContext) | null;
  /** Siren data (default `src/data/audio/sirens.json`). */
  data?: SirenData;
}

/** Volume change smoothing (s). */
const VOLUME_TAU = 0.015;
/** Seed of the shared 1 s noise buffer. */
const NOISE_SEED = 0x5eed1e55;

type ContextCtor = new () => AudioContext;

function browserContextFactory(): (() => AudioContext) | null {
  const g = globalThis as { AudioContext?: ContextCtor; webkitAudioContext?: ContextCtor };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  return Ctor ? () => new Ctor() : null;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

export class AudioEngine {
  readonly stats: AudioStats = { voices: 0, active: 0 };
  readonly sirens: SirenBank;
  readonly radio: RadioFx;
  private factory: (() => AudioContext) | null;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private radioBus: GainNode | null = null;
  private readonly volumes: AudioVolumes = { master: 0.8, sfx: 1, radio: 1 };
  private readonly listener: ListenerState = { x: 0, y: 0, z: 0 };
  private paused = false;
  private disposed = false;

  constructor(options: AudioEngineOptions = {}) {
    this.factory = options.contextFactory !== undefined ? options.contextFactory : browserContextFactory();
    this.sirens = new SirenBank(this.stats, options.data ?? SIREN_DATA);
    this.radio = new RadioFx();
  }

  /** True when the browser offers Web Audio (and the engine is not disposed). */
  get available(): boolean {
    return this.factory !== null && !this.disposed;
  }

  /** True once `unlock()` built the graph. */
  get unlocked(): boolean {
    return this.ctx !== null;
  }

  /** Call from a user gesture: creates the context and graph once, then resumes it. Idempotent. */
  unlock(): void {
    if (!this.available) return;
    try {
      if (!this.ctx) this.build();
      const ctx = this.ctx;
      if (ctx && !this.paused && ctx.state === 'suspended') swallow(ctx.resume());
    } catch (err) {
      log.warn(`Audio unavailable: ${String(err)}`);
      this.teardown();
      this.factory = null;
    }
  }

  setVolumes(v: AudioVolumes): void {
    this.volumes.master = clamp01(v.master);
    this.volumes.sfx = clamp01(v.sfx);
    this.volumes.radio = clamp01(v.radio);
    this.applyVolumes();
  }

  /** Pause: suspends the context (sirens and radio FX stop advancing). */
  suspend(): void {
    this.paused = true;
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      if (ctx.state === 'running') swallow(ctx.suspend());
    } catch {
      // ignore
    }
  }

  resume(): void {
    this.paused = false;
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') swallow(ctx.resume());
    } catch {
      // ignore
    }
  }

  /** Listener pose (world metres; forward and up unit vectors). Call every frame before `sirens.update`. */
  setListener(x: number, y: number, z: number, fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void {
    const l = this.listener;
    l.x = x;
    l.y = y;
    l.z = z;
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      setListenerPose(ctx.listener, x, y, z, fx, fy, fz, ux, uy, uz);
    } catch {
      // ignore
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.teardown();
    this.disposed = true;
  }

  private build(): void {
    const factory = this.factory;
    if (!factory) return;
    const ctx = factory();
    this.ctx = ctx;
    const master = ctx.createGain();
    const sfx = ctx.createGain();
    const radio = ctx.createGain();
    master.gain.value = this.volumes.master;
    sfx.gain.value = this.volumes.sfx;
    radio.gain.value = this.volumes.radio;
    sfx.connect(master);
    radio.connect(master);
    master.connect(ctx.destination);
    this.master = master;
    this.sfx = sfx;
    this.radioBus = radio;

    const rate = ctx.sampleRate > 0 ? ctx.sampleRate : 48000;
    const noise = ctx.createBuffer(1, Math.round(rate), rate);
    fillNoise(noise.getChannelData(0), NOISE_SEED);

    this.sirens.build(ctx, sfx, this.listener);
    this.radio.attach(ctx, radio, noise);
  }

  private applyVolumes(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.sfx || !this.radioBus) return;
    try {
      const now = ctx.currentTime;
      glide(this.master.gain, this.volumes.master, now, VOLUME_TAU);
      glide(this.sfx.gain, this.volumes.sfx, now, VOLUME_TAU);
      glide(this.radioBus.gain, this.volumes.radio, now, VOLUME_TAU);
    } catch {
      // ignore
    }
  }

  private teardown(): void {
    this.sirens.detach();
    this.radio.detach();
    const ctx = this.ctx;
    if (this.master) safeDisconnect(this.master);
    this.master = null;
    this.sfx = null;
    this.radioBus = null;
    this.ctx = null;
    if (ctx) {
      try {
        swallow(ctx.close());
      } catch {
        // ignore
      }
    }
  }
}
