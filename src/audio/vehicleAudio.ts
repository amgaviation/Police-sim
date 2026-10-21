import { SIREN_DATA } from './data';
import { createAudioStats, type AudioStats } from './sirens';
import { glide, safeDisconnect, setNodePosition, type ListenerState } from './nodes';
import { VEHICLE_AUDIO, type EngineProfile, type EngineProfileId, type VehicleAudioData } from './vehicleData';
import { crunchLevel, engineCutoffHz, engineGain, firingHz, rpmFromSpeed, squealHz, squealLevel, tireSlip } from './vehicleMath';

/**
 * Engine, tire and traffic-engine voices (phase 9 design §5.4). The whole node graph is built once by the audio
 * engine on unlock; `update` afterwards only writes AudioParams (no node creation, no allocation). Without a
 * context every method is a no-op and nothing here ever throws.
 */

export interface DrivenAudioState {
  /** False: no driven / controlled vehicle (engine and tire voices fade out). */
  active: boolean;
  profile: EngineProfileId | null;
  rpm: number;
  throttle: number;
  running: boolean;
  speed: number;
  groundSpeed: number;
  brake: number;
  handbrake: boolean;
  absActive: boolean;
  /** SURFACE id under the front-left wheel (telemetry.wheelSurface[0]). */
  surface: number;
  airborne: boolean;
  /** Camera is the cockpit / hood view or first person in the car: cabin gain + lowpass. */
  inCabin: boolean;
  x: number;
  y: number;
  z: number;
}

export interface TrafficAudioSource {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Speed (m/s). */
  speed: number;
}

/** Glide time constant of every engine / tire parameter (s). */
const GLIDE_TAU = 0.05;
/** Level of the second harmonic oscillator. */
const HARMONIC_GAIN = 0.35;
/** Sliding-noise level relative to the squeal sine. */
const SLIDE_MIX = 0.6;
/** Crunch noise low-pass (Hz). */
const CRUNCH_LOWPASS_HZ = 900;
/** Assumed throttle of a traffic car. */
const TRAFFIC_THROTTLE = 0.4;
/** Traffic voice level relative to the driven engine gain. */
const TRAFFIC_LEVEL = 0.25;
/** Open (no cabin) low-pass cutoff (Hz). */
const OPEN_LOWPASS_HZ = 20000;
/** Highest bandpass centre for the noise layer (Hz). */
const MAX_NOISE_HZ = 12000;
const FREE = -1;
const UNMATCHED = -1;

interface DrivenVoice {
  readonly oscA: OscillatorNode;
  readonly oscB: OscillatorNode;
  readonly sub: OscillatorNode;
  readonly noiseSrc: AudioBufferSourceNode;
  readonly noiseBp: BiquadFilterNode;
  readonly subGain: GainNode;
  readonly noiseGain: GainNode;
  readonly lowpass: BiquadFilterNode;
  readonly am: GainNode;
  readonly lfo: OscillatorNode;
  readonly lfoDepth: GainNode;
  readonly gain: GainNode;
  readonly cabinLp: BiquadFilterNode;
  readonly panner: PannerNode;
  readonly squeal: OscillatorNode;
  readonly squealGain: GainNode;
  readonly slideBp: BiquadFilterNode;
  readonly slideGain: GainNode;
  readonly crunchLp: BiquadFilterNode;
  readonly crunchGain: GainNode;
  profile: EngineProfileId | null;
  /** Last cabin state written (null = never). */
  inCabin: boolean | null;
  /** True while the voices are faded out (no redundant writes while inactive). */
  silent: boolean;
}

interface TrafficVoice {
  readonly osc: OscillatorNode;
  readonly lowpass: BiquadFilterNode;
  readonly gain: GainNode;
  readonly panner: PannerNode;
  sourceId: number;
}

function startAt(node: OscillatorNode | AudioBufferSourceNode): void {
  node.start();
}

export class VehicleAudio {
  private readonly data: VehicleAudioData;
  private readonly stats: AudioStats;
  private ctx: BaseAudioContext | null = null;
  private listener: ListenerState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  private driven: DrivenVoice | null = null;
  private readonly traffic: TrafficVoice[] = [];
  private selected = new Int32Array(0);
  private selectedDist = new Float64Array(0);
  private match = new Int32Array(0);
  private claimed = new Uint8Array(0);

  constructor(stats: AudioStats = createAudioStats(), data: VehicleAudioData = VEHICLE_AUDIO) {
    this.stats = stats;
    this.data = data;
  }

  /**
   * @internal Engine unlock: builds the driven voice (2 oscillators + sub + noise layer + lowpass + AM gain), the tire
   * voice (bandpassed noise + squeal sine + crunch lowpassed noise) and `traffic.voices` pooled traffic voices (one
   * oscillator + lowpass + panner each); never builds nodes later.
   */
  build(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, listener: ListenerState): void {
    if (this.ctx) return;
    this.ctx = ctx;
    this.listener = listener;
    const d = this.data;
    const car = d.engine.profiles.car;
    const t = d.tires;

    const oscA = ctx.createOscillator();
    oscA.type = car.wave;
    const oscB = ctx.createOscillator();
    oscB.type = car.wave;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    const harmonicGain = ctx.createGain();
    harmonicGain.gain.value = HARMONIC_GAIN;
    const subGain = ctx.createGain();
    subGain.gain.value = car.subGain;

    // One looped noise source feeds the engine layer, the sliding noise and the crunch (three filters).
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noise;
    noiseSrc.loop = true;
    const noiseBp = ctx.createBiquadFilter();
    noiseBp.type = 'bandpass';
    noiseBp.Q.value = 1.5;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = car.lowpassBaseHz;
    const am = ctx.createGain();
    am.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0;
    lfo.connect(lfoDepth);
    lfoDepth.connect(am.gain);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const cabinLp = ctx.createBiquadFilter();
    cabinLp.type = 'lowpass';
    cabinLp.frequency.value = OPEN_LOWPASS_HZ;
    const panner = ctx.createPanner();
    this.configurePanner(panner);

    oscA.connect(lowpass);
    oscB.connect(harmonicGain);
    harmonicGain.connect(lowpass);
    sub.connect(subGain);
    subGain.connect(lowpass);
    noiseSrc.connect(noiseBp);
    noiseBp.connect(noiseGain);
    noiseGain.connect(lowpass);
    lowpass.connect(am);
    am.connect(gain);
    gain.connect(cabinLp);

    const squeal = ctx.createOscillator();
    squeal.type = 'sine';
    squeal.frequency.value = t.squealHzMin;
    const squealGain = ctx.createGain();
    squealGain.gain.value = 0;
    const slideBp = ctx.createBiquadFilter();
    slideBp.type = 'bandpass';
    slideBp.frequency.value = t.noiseHz;
    slideBp.Q.value = t.noiseQ;
    const slideGain = ctx.createGain();
    slideGain.gain.value = 0;
    const crunchLp = ctx.createBiquadFilter();
    crunchLp.type = 'lowpass';
    crunchLp.frequency.value = CRUNCH_LOWPASS_HZ;
    const crunchGain = ctx.createGain();
    crunchGain.gain.value = 0;
    squeal.connect(squealGain);
    squealGain.connect(cabinLp);
    noiseSrc.connect(slideBp);
    slideBp.connect(slideGain);
    slideGain.connect(cabinLp);
    noiseSrc.connect(crunchLp);
    crunchLp.connect(crunchGain);
    crunchGain.connect(cabinLp);

    cabinLp.connect(panner);
    panner.connect(out);

    const dur = noise.duration;
    noiseSrc.start(0, dur > 0 ? dur * 0.31 : 0);
    for (const o of [oscA, oscB, sub, lfo, squeal]) startAt(o);

    this.driven = {
      oscA,
      oscB,
      sub,
      noiseSrc,
      noiseBp,
      subGain,
      noiseGain,
      lowpass,
      am,
      lfo,
      lfoDepth,
      gain,
      cabinLp,
      panner,
      squeal,
      squealGain,
      slideBp,
      slideGain,
      crunchLp,
      crunchGain,
      profile: null,
      inCabin: null,
      silent: true,
    };

    const tr = d.engine.traffic;
    const trafficProfile = d.engine.profiles[tr.profile];
    for (let i = 0; i < tr.voices; i++) {
      const osc = ctx.createOscillator();
      osc.type = trafficProfile.wave;
      osc.frequency.value = Math.max(1, firingHz(tr.idleRpm, trafficProfile.cylinders));
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = trafficProfile.lowpassBaseHz;
      const g = ctx.createGain();
      g.gain.value = 0;
      const p = ctx.createPanner();
      this.configurePanner(p);
      osc.connect(lp);
      lp.connect(g);
      g.connect(p);
      p.connect(out);
      osc.start();
      this.traffic.push({ osc, lowpass: lp, gain: g, panner: p, sourceId: FREE });
    }
    const n = this.traffic.length;
    this.selected = new Int32Array(n);
    this.selectedDist = new Float64Array(n);
    this.match = new Int32Array(n);
    this.claimed = new Uint8Array(n);
  }

  /** @internal Drops the graph (engine dispose). */
  detach(): void {
    const d = this.driven;
    if (d) {
      for (const o of [d.oscA, d.oscB, d.sub, d.lfo, d.squeal]) this.stopNode(o);
      this.stopNode(d.noiseSrc);
      safeDisconnect(d.panner);
    }
    for (const v of this.traffic) {
      this.stopNode(v.osc);
      safeDisconnect(v.panner);
    }
    this.ctx = null;
    this.driven = null;
    this.traffic.length = 0;
    this.stats.engine = 0;
    this.stats.traffic = 0;
  }

  /**
   * Per frame; AudioParam writes only (glide tau 0.05 s); no allocation. A profile change retunes in place.
   * `traffic[0..trafficCount)` are candidate cars; the nearest ones within `traffic.maxDistanceM` get a voice.
   */
  update(driven: Readonly<DrivenAudioState>, traffic: readonly TrafficAudioSource[], trafficCount: number): void {
    const ctx = this.ctx;
    const voice = this.driven;
    if (!ctx || !voice) return;
    try {
      const now = ctx.currentTime;
      this.updateDriven(voice, driven, now);
      this.updateTraffic(traffic, trafficCount, now);
    } catch {
      // never throw from audio
    }
  }

  private stopNode(node: OscillatorNode | AudioBufferSourceNode): void {
    try {
      node.stop();
    } catch {
      // not started or already stopped
    }
  }

  private configurePanner(p: PannerNode): void {
    // Same settings as the siren voices.
    const d = SIREN_DATA.panner;
    p.panningModel = 'equalpower';
    p.distanceModel = d.model;
    p.refDistance = d.refDistance;
    p.rolloffFactor = d.rolloff;
    p.maxDistance = d.maxDistance;
  }

  private retune(v: DrivenVoice, id: EngineProfileId, p: EngineProfile, now: number): void {
    v.profile = id;
    v.oscA.type = p.wave;
    v.oscB.type = p.wave;
    glide(v.subGain.gain, p.subGain, now, GLIDE_TAU);
    if (p.am > 0) {
      glide(v.am.gain, 1 - p.am / 2, now, GLIDE_TAU);
      glide(v.lfoDepth.gain, p.am / 2, now, GLIDE_TAU);
    } else {
      glide(v.am.gain, 1, now, GLIDE_TAU);
      glide(v.lfoDepth.gain, 0, now, GLIDE_TAU);
    }
  }

  private updateDriven(v: DrivenVoice, d: Readonly<DrivenAudioState>, now: number): void {
    const data = this.data;
    const profile = d.active && d.profile !== null ? data.engine.profiles[d.profile] : undefined;
    if (profile === undefined || d.profile === null) {
      if (!v.silent) {
        v.silent = true;
        glide(v.gain.gain, 0, now, GLIDE_TAU);
        glide(v.squealGain.gain, 0, now, GLIDE_TAU);
        glide(v.slideGain.gain, 0, now, GLIDE_TAU);
        glide(v.crunchGain.gain, 0, now, GLIDE_TAU);
        glide(v.noiseGain.gain, 0, now, GLIDE_TAU);
      }
      this.stats.engine = 0;
      return;
    }
    v.silent = false;
    if (v.profile !== d.profile) this.retune(v, d.profile, profile, now);
    if (v.inCabin !== d.inCabin) {
      v.inCabin = d.inCabin;
      glide(v.cabinLp.frequency, d.inCabin ? data.engine.cabin.lowpassHz : OPEN_LOWPASS_HZ, now, GLIDE_TAU);
    }
    const cabin = d.inCabin ? data.engine.cabin.gain : 1;
    const rpm = d.rpm > 0 ? d.rpm : 0;
    const throttle = d.throttle < 0 ? 0 : d.throttle > 1 ? 1 : d.throttle;

    const fire = Math.max(1, firingHz(rpm, profile.cylinders));
    glide(v.oscA.frequency, fire, now, GLIDE_TAU);
    glide(v.oscB.frequency, fire * 2, now, GLIDE_TAU);
    glide(v.sub.frequency, fire / 2, now, GLIDE_TAU);
    glide(v.noiseBp.frequency, Math.min(MAX_NOISE_HZ, fire * 2), now, GLIDE_TAU);
    glide(v.lfo.frequency, fire / 4, now, GLIDE_TAU);
    glide(v.lowpass.frequency, engineCutoffHz(profile, rpm, throttle), now, GLIDE_TAU);
    glide(v.noiseGain.gain, d.running ? profile.noiseGain * (0.3 + 0.7 * throttle) : 0, now, GLIDE_TAU);
    glide(v.gain.gain, engineGain(profile, data.engine.idleGain, throttle, d.running) * cabin, now, GLIDE_TAU);

    const t = data.tires;
    const slip = tireSlip(d.speed, d.groundSpeed, d.brake, d.absActive, d.handbrake, t.lockSpeedMs);
    const squeal = squealLevel(slip, d.surface, d.airborne, t) * t.gain * cabin;
    glide(v.squeal.frequency, squealHz(slip, t), now, GLIDE_TAU);
    glide(v.squealGain.gain, squeal, now, GLIDE_TAU);
    glide(v.slideGain.gain, squeal * SLIDE_MIX, now, GLIDE_TAU);
    glide(v.crunchGain.gain, crunchLevel(d.groundSpeed, d.surface, d.airborne, t) * cabin, now, GLIDE_TAU);

    if (d.inCabin) {
      const l = this.listener;
      setNodePosition(v.panner, l.x, l.y, l.z);
    } else {
      setNodePosition(v.panner, d.x, d.y, d.z);
    }
    this.stats.engine = d.running ? 1 : 0;
  }

  private updateTraffic(sources: readonly TrafficAudioSource[], count: number, now: number): void {
    const voices = this.traffic;
    const nv = voices.length;
    if (nv === 0) return;
    const tr = this.data.engine.traffic;
    const profile = this.data.engine.profiles[tr.profile];
    const l = this.listener;
    const n = this.selectNearest(sources, count, l.x, l.z, tr.maxDistanceM);
    const match = this.match;
    const claimed = this.claimed;
    match.fill(UNMATCHED);
    claimed.fill(0);

    // 1. Keep voices on the cars that are still selected.
    for (let k = 0; k < n; k++) {
      const id = sources[this.selected[k] ?? 0]?.id;
      for (let v = 0; v < nv; v++) {
        if (match[v] === UNMATCHED && voices[v]?.sourceId === id) {
          match[v] = this.selected[k] ?? 0;
          claimed[k] = 1;
          break;
        }
      }
    }
    // 2. New cars take idle voices first, then voices being released.
    for (let k = 0; k < n; k++) {
      if (claimed[k] === 1) continue;
      let pick = -1;
      for (let v = 0; v < nv; v++) {
        if (match[v] !== UNMATCHED) continue;
        if (voices[v]?.sourceId === FREE) {
          pick = v;
          break;
        }
        if (pick < 0) pick = v;
      }
      if (pick >= 0) match[pick] = this.selected[k] ?? 0;
    }
    // 3. Drive the voices.
    let active = 0;
    for (let v = 0; v < nv; v++) {
      const voice = voices[v];
      if (!voice) continue;
      const m = match[v] ?? UNMATCHED;
      const src = m >= 0 ? sources[m] : undefined;
      if (src === undefined) {
        if (voice.sourceId !== FREE) {
          voice.sourceId = FREE;
          glide(voice.gain.gain, 0, now, GLIDE_TAU);
        }
        continue;
      }
      voice.sourceId = src.id;
      const rpm = rpmFromSpeed(src.speed, tr);
      glide(voice.osc.frequency, Math.max(1, firingHz(rpm, profile.cylinders)), now, GLIDE_TAU);
      glide(voice.lowpass.frequency, engineCutoffHz(profile, rpm, TRAFFIC_THROTTLE), now, GLIDE_TAU);
      glide(voice.gain.gain, TRAFFIC_LEVEL * engineGain(profile, this.data.engine.idleGain, TRAFFIC_THROTTLE, true), now, GLIDE_TAU);
      setNodePosition(voice.panner, src.x, src.y, src.z);
      active++;
    }
    this.stats.traffic = active;
  }

  /** Indices of up to `voices` nearest sources within `maxDist` (XZ), nearest first (ties keep the lower index). */
  private selectNearest(sources: readonly TrafficAudioSource[], count: number, lx: number, lz: number, maxDist: number): number {
    const cap = this.selected.length;
    if (cap === 0) return 0;
    const out = this.selected;
    const dist = this.selectedDist;
    const maxSq = maxDist * maxDist;
    const n = Math.min(count, sources.length);
    let filled = 0;
    for (let i = 0; i < n; i++) {
      const s = sources[i];
      if (s === undefined) continue;
      const dx = s.x - lx;
      const dz = s.z - lz;
      const dSq = dx * dx + dz * dz;
      if (!(dSq <= maxSq)) continue;
      let j = filled;
      if (j === cap) {
        if (dSq >= (dist[cap - 1] ?? Infinity)) continue;
        j = cap - 1;
      } else {
        filled++;
      }
      while (j > 0 && (dist[j - 1] ?? 0) > dSq) {
        dist[j] = dist[j - 1] ?? 0;
        out[j] = out[j - 1] ?? 0;
        j--;
      }
      dist[j] = dSq;
      out[j] = i;
    }
    return filled;
  }
}
