import { log } from '../core/log';
import { AmbienceBed } from './ambience';
import { SIREN_DATA, type SirenData } from './data';
import { fillNoise, glide, safeDisconnect, setListenerPose, swallow, type ListenerState } from './nodes';
import { RadioFx } from './radioFx';
import { SirenBank, createAudioStats, type AudioStats } from './sirens';
import { UiSounds } from './uiSounds';
import { VehicleAudio } from './vehicleAudio';

/**
 * The game's single Web Audio context (design §10.1, phase 9 §5.1): created lazily by `unlock()` from a
 * user gesture, graph `destination <- master <- { sfx, radio, ambience, ui }`. `sfx` carries sirens, engines and
 * tires; `radio` the radio FX and chatter; `ambience` the beds; `ui` the UI sounds. Without an AudioContext
 * constructor (node, old browsers) `available` is false and every method is a no-op. No method ever throws.
 */

/** The five volume buses, in graph order. */
export const AUDIO_BUSES = ['master', 'sfx', 'radio', 'ambience', 'ui'] as const;
export type AudioBusName = (typeof AUDIO_BUSES)[number];

export interface AudioVolumes {
  master: number;
  sfx: number;
  radio: number;
  ambience: number;
  ui: number;
}

export interface AudioEngineOptions {
  /** Context constructor seam (tests inject a fake); null disables audio. Default: the browser's. */
  contextFactory?: (() => AudioContext) | null;
  /** Siren data (default `src/data/audio/sirens.json`). */
  data?: SirenData;
}

/** Volume change smoothing (s). */
const VOLUME_TAU = 0.015;
/** Pause / resume fade of the world buses (s). */
const PAUSE_TAU = 0.03;
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
  readonly stats: AudioStats = createAudioStats();
  readonly sirens: SirenBank;
  readonly radio: RadioFx;
  readonly vehicles: VehicleAudio;
  readonly ambience: AmbienceBed;
  readonly ui: UiSounds;
  private factory: (() => AudioContext) | null;
  private ctx: AudioContext | null = null;
  private readonly buses: Partial<Record<AudioBusName, GainNode>> = {};
  private readonly volumes: AudioVolumes = { master: 0.8, sfx: 1, radio: 1, ambience: 0.7, ui: 0.6 };
  private readonly listener: ListenerState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  private paused = false;
  private disposed = false;

  constructor(options: AudioEngineOptions = {}) {
    this.factory = options.contextFactory !== undefined ? options.contextFactory : browserContextFactory();
    this.sirens = new SirenBank(this.stats, options.data ?? SIREN_DATA);
    this.radio = new RadioFx(this.stats);
    this.vehicles = new VehicleAudio(this.stats);
    this.ambience = new AmbienceBed(this.stats);
    this.ui = new UiSounds(this.stats);
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
      if (ctx && ctx.state === 'suspended') swallow(ctx.resume());
    } catch (err) {
      log.warn(`Audio unavailable: ${String(err)}`);
      this.teardown();
      this.factory = null;
    }
  }

  /** Bus volumes (0..1, clamped; a missing `ambience` / `ui` from an older caller means 1). */
  setVolumes(v: Pick<AudioVolumes, 'master' | 'sfx' | 'radio'> & Partial<AudioVolumes>): void {
    this.volumes.master = clamp01(v.master);
    this.volumes.sfx = clamp01(v.sfx);
    this.volumes.radio = clamp01(v.radio);
    this.volumes.ambience = clamp01(v.ambience ?? 1);
    this.volumes.ui = clamp01(v.ui ?? 1);
    this.applyVolumes(VOLUME_TAU);
  }

  /**
   * Pause: the sfx, radio and ambience buses glide to 0 (the context keeps running so UI sounds still play in the
   * pause menus). The world voices keep accepting updates; they only write params.
   */
  suspend(): void {
    this.paused = true;
    this.applyVolumes(PAUSE_TAU);
  }

  resume(): void {
    this.paused = false;
    this.applyVolumes(PAUSE_TAU);
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

  /** Listener velocity (m/s), used for the siren Doppler shift. Call every frame with the listener pose. */
  setListenerVelocity(vx: number, vy: number, vz: number): void {
    const l = this.listener;
    l.vx = Number.isFinite(vx) ? vx : 0;
    l.vy = Number.isFinite(vy) ? vy : 0;
    l.vz = Number.isFinite(vz) ? vz : 0;
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
    const buses = this.buses;
    for (const name of AUDIO_BUSES) {
      const g = ctx.createGain();
      g.gain.value = this.busTarget(name);
      buses[name] = g;
    }
    const master = buses.master;
    const sfx = buses.sfx;
    const radio = buses.radio;
    const ambience = buses.ambience;
    const ui = buses.ui;
    if (!master || !sfx || !radio || !ambience || !ui) return;
    sfx.connect(master);
    radio.connect(master);
    ambience.connect(master);
    ui.connect(master);
    master.connect(ctx.destination);

    const rate = ctx.sampleRate > 0 ? ctx.sampleRate : 48000;
    const noise = ctx.createBuffer(1, Math.round(rate), rate);
    fillNoise(noise.getChannelData(0), NOISE_SEED);

    this.sirens.build(ctx, sfx, this.listener);
    this.vehicles.build(ctx, sfx, noise, this.listener);
    this.ambience.build(ctx, ambience, noise);
    this.radio.attach(ctx, radio, noise);
    this.ui.attach(ctx, ui);
  }

  /** Target gain of a bus: paused world buses are 0, the ui bus keeps its volume. */
  private busTarget(name: AudioBusName): number {
    if (this.paused && (name === 'sfx' || name === 'radio' || name === 'ambience')) return 0;
    return this.volumes[name];
  }

  private applyVolumes(tau: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      for (const name of AUDIO_BUSES) {
        const g = this.buses[name];
        if (g) glide(g.gain, this.busTarget(name), now, tau);
      }
    } catch {
      // ignore
    }
  }

  private teardown(): void {
    this.sirens.detach();
    this.vehicles.detach();
    this.ambience.detach();
    this.radio.detach();
    this.ui.detach();
    const ctx = this.ctx;
    const master = this.buses.master;
    if (master) safeDisconnect(master);
    for (const name of AUDIO_BUSES) delete this.buses[name];
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
