import { SIREN_DATA, type SirenData, type SirenToneName } from './data';
import { chooseNearest, dopplerRatio, ratioToCents, type SirenEmitter } from './math';
import { glide, setNodePosition, softClipCurve, type ListenerState } from './nodes';
import { VEHICLE_AUDIO } from './vehicleData';

/**
 * Positional synthesized siren voices (design §10.2). The whole node graph is built once
 * by the engine on unlock; `update` afterwards only writes AudioParams (no node creation,
 * no allocation). Without a context every method is a no-op.
 */

const FREE = -1;
/** Emitter id of the console `sirentest` emitter. */
const TEST_ID = -2;
/** `match` slot value for the test emitter. */
const TEST_SLOT = -2;
const UNMATCHED = -1;
/** Retune time constant for tone changes (s). */
const RETUNE_TAU = 0.02;
/** Fade time constant of a voice that loses its emitter (s). */
const RELEASE_TAU = 0.08;
/** Air horn gate level (two oscillators summed). */
const HORN_LEVEL = 0.5;
/** A Doppler detune is rewritten only when it moved by more than this (cents). */
const DETUNE_EPSILON_CENTS = 0.5;

interface Voice {
  readonly osc: OscillatorNode;
  readonly lfo: OscillatorNode;
  readonly depth: GainNode;
  readonly sirenGate: GainNode;
  readonly horns: readonly OscillatorNode[];
  readonly hornGate: GainNode;
  readonly lowpass: BiquadFilterNode;
  readonly shaper: WaveShaperNode;
  readonly gain: GainNode;
  readonly panner: PannerNode;
  emitterId: number;
  tone: SirenToneName | null;
  manual: boolean;
  horn: boolean;
  inCabin: boolean;
  /** Doppler detune last written to the oscillators (cents). */
  cents: number;
}

export interface AudioStats {
  /** Siren voices built (0 before unlock). */
  voices: number;
  /** Voices currently assigned to an emitter. */
  active: number;
  /** 1 while the driven vehicle's engine voice is audible. */
  engine: 0 | 1;
  /** Traffic engine voices currently assigned to a car. */
  traffic: number;
  /** Ambience layers with a non-zero target gain. */
  ambienceLayers: number;
  /** UI tones scheduled and not yet ended. */
  uiPlaying: number;
  /** Radio chatter bursts currently on the air. */
  chatter: number;
}

/** Fresh zeroed stats (shared by the engine and every audio sub-module). */
export function createAudioStats(): AudioStats {
  return { voices: 0, active: 0, engine: 0, traffic: 0, ambienceLayers: 0, uiPlaying: 0, chatter: 0 };
}

export type SirenTestKind = SirenToneName | 'horn';

export class SirenBank {
  private readonly data: SirenData;
  private readonly stats: AudioStats;
  private ctx: BaseAudioContext | null = null;
  private listener: ListenerState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  private readonly voices: Voice[] = [];
  private selected = new Int32Array(0);
  private claimed = new Uint8Array(0);
  private match = new Int32Array(0);
  private readonly testEmitter: SirenEmitter = {
    id: TEST_ID,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    tone: null,
    horn: false,
    manual: false,
    inCabin: true,
  };
  private testUntil = 0;

  constructor(stats: AudioStats = createAudioStats(), data: SirenData = SIREN_DATA) {
    this.stats = stats;
    this.data = data;
  }

  /** @internal Builds the voice pool (engine unlock). */
  build(ctx: BaseAudioContext, out: AudioNode, listener: ListenerState): void {
    if (this.ctx) return;
    this.ctx = ctx;
    this.listener = listener;
    const d = this.data;
    const curve = softClipCurve();
    const wail = d.tones.wail;
    for (let i = 0; i < d.voices; i++) {
      const osc = ctx.createOscillator();
      osc.type = d.voice.wave;
      osc.frequency.value = (wail.lowHz + wail.highHz) / 2;
      const lfo = ctx.createOscillator();
      lfo.type = wail.shape;
      lfo.frequency.value = 1 / wail.periodS;
      const depth = ctx.createGain();
      depth.gain.value = (wail.highHz - wail.lowHz) / 2;
      lfo.connect(depth);
      depth.connect(osc.frequency);
      const sirenGate = ctx.createGain();
      sirenGate.gain.value = 0;
      osc.connect(sirenGate);
      const hornGate = ctx.createGain();
      hornGate.gain.value = 0;
      const horns: OscillatorNode[] = [];
      for (const f of d.horn.freqsHz) {
        const h = ctx.createOscillator();
        h.type = 'sawtooth';
        h.frequency.value = f;
        h.connect(hornGate);
        horns.push(h);
      }
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = d.voice.lowpassHz;
      const shaper = ctx.createWaveShaper();
      shaper.curve = curve;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = d.panner.model;
      panner.refDistance = d.panner.refDistance;
      panner.rolloffFactor = d.panner.rolloff;
      panner.maxDistance = d.panner.maxDistance;
      sirenGate.connect(lowpass);
      hornGate.connect(lowpass);
      lowpass.connect(shaper);
      shaper.connect(gain);
      gain.connect(panner);
      panner.connect(out);
      osc.start();
      lfo.start();
      for (const h of horns) h.start();
      this.voices.push({
        osc,
        lfo,
        depth,
        sirenGate,
        horns,
        hornGate,
        lowpass,
        shaper,
        gain,
        panner,
        emitterId: FREE,
        tone: null,
        manual: false,
        horn: false,
        inCabin: false,
        cents: 0,
      });
    }
    const n = this.voices.length;
    this.selected = new Int32Array(n);
    this.claimed = new Uint8Array(n);
    this.match = new Int32Array(n);
    this.stats.voices = n;
    this.stats.active = 0;
  }

  /** @internal Drops the graph (engine dispose). */
  detach(): void {
    this.ctx = null;
    this.voices.length = 0;
    this.stats.voices = 0;
    this.stats.active = 0;
  }

  /**
   * Plays a test siren in the cabin for `durationS` (console `sirentest`); null stops it.
   * Takes one voice on the next `update`.
   */
  test(kind: SirenTestKind | null, durationS = 3): void {
    const ctx = this.ctx;
    const t = this.testEmitter;
    t.tone = kind === null || kind === 'horn' ? null : kind;
    t.horn = kind === 'horn';
    this.testUntil = ctx ? ctx.currentTime + Math.max(0, durationS) : 0;
  }

  /**
   * Per frame: assigns the voices to the nearest sounding emitters of `emitters[0..count)`
   * (sticky: a voice stays on its emitter while that emitter is selected), writes panner
   * positions and fades unused voices out. AudioParam writes only.
   */
  update(emitters: readonly SirenEmitter[], count: number, listenerX: number, listenerZ: number): void {
    const ctx = this.ctx;
    const voices = this.voices;
    if (!ctx || voices.length === 0) return;
    try {
      const now = ctx.currentTime;
      const test = this.testEmitter;
      let testActive = test.tone !== null || test.horn;
      if (testActive && now >= this.testUntil) {
        test.tone = null;
        test.horn = false;
        testActive = false;
      }
      const nv = voices.length;
      const capacity = testActive ? nv - 1 : nv;
      const n = chooseNearest(emitters, count, listenerX, listenerZ, capacity, this.data.maxAudibleM, this.selected);
      const match = this.match;
      const claimed = this.claimed;
      match.fill(UNMATCHED);
      claimed.fill(0);

      // 1. Keep voices on emitters that are still selected.
      for (let k = 0; k < n; k++) {
        const id = emitters[this.selected[k] ?? 0]?.id;
        for (let v = 0; v < nv; v++) {
          if (match[v] === UNMATCHED && voices[v]?.emitterId === id) {
            match[v] = this.selected[k] ?? 0;
            claimed[k] = 1;
            break;
          }
        }
      }
      let testClaimed = !testActive;
      if (testActive) {
        for (let v = 0; v < nv; v++) {
          if (match[v] === UNMATCHED && voices[v]?.emitterId === TEST_ID) {
            match[v] = TEST_SLOT;
            testClaimed = true;
            break;
          }
        }
      }
      // 2. New emitters take idle voices first, then voices being released.
      if (!testClaimed) this.claimVoice(TEST_SLOT);
      for (let k = 0; k < n; k++) {
        if (claimed[k] === 0) this.claimVoice(this.selected[k] ?? 0);
      }

      // 3. Drive the voices.
      let active = 0;
      for (let v = 0; v < nv; v++) {
        const voice = voices[v];
        if (!voice) continue;
        const m = match[v] ?? UNMATCHED;
        const e = m === TEST_SLOT ? test : m >= 0 ? emitters[m] : undefined;
        if (e === undefined) {
          if (voice.emitterId !== FREE) this.release(voice, now);
          continue;
        }
        this.apply(voice, e, now);
        active++;
      }
      this.stats.active = active;
    } catch {
      // never throw from audio
    }
  }

  private claimVoice(slot: number): void {
    const voices = this.voices;
    const match = this.match;
    let pick = -1;
    for (let v = 0; v < voices.length; v++) {
      if (match[v] !== UNMATCHED) continue;
      if (voices[v]?.emitterId === FREE) {
        pick = v;
        break;
      }
      if (pick < 0) pick = v;
    }
    if (pick >= 0) match[pick] = slot;
  }

  private apply(voice: Voice, e: SirenEmitter, now: number): void {
    const d = this.data;
    const fresh = voice.emitterId !== e.id;
    if (fresh) voice.emitterId = e.id;

    if (fresh || e.inCabin !== voice.inCabin) {
      voice.inCabin = e.inCabin;
      glide(voice.lowpass.frequency, e.inCabin ? d.cabin.lowpassHz : d.voice.lowpassHz, now, RETUNE_TAU);
      glide(voice.gain.gain, d.voice.gain * (e.inCabin ? d.cabin.gain : 1), now, RETUNE_TAU);
    }

    if (fresh || e.manual !== voice.manual || e.tone !== voice.tone) {
      const wasManual = !fresh && voice.manual;
      voice.manual = e.manual;
      voice.tone = e.tone;
      if (e.manual) {
        glide(voice.depth.gain, 0, now, RETUNE_TAU);
        glide(voice.osc.frequency, d.manual.maxHz, now, d.manual.riseS / 3);
        glide(voice.sirenGate.gain, 1, now, RETUNE_TAU);
      } else if (e.tone !== null) {
        const spec = d.tones[e.tone];
        voice.lfo.type = spec.shape;
        glide(voice.lfo.frequency, 1 / spec.periodS, now, RETUNE_TAU);
        glide(voice.depth.gain, (spec.highHz - spec.lowHz) / 2, now, RETUNE_TAU);
        glide(voice.osc.frequency, (spec.lowHz + spec.highHz) / 2, now, RETUNE_TAU);
        glide(voice.sirenGate.gain, 1, now, RETUNE_TAU);
      } else if (wasManual) {
        // Manual released while the horn keeps the voice: wind down, then fade.
        glide(voice.osc.frequency, d.manual.minHz, now, d.manual.fallS / 3);
        glide(voice.sirenGate.gain, 0, now, d.manual.fallS / 3);
      } else {
        glide(voice.sirenGate.gain, 0, now, RETUNE_TAU);
      }
    }

    if (fresh || e.horn !== voice.horn) {
      voice.horn = e.horn;
      glide(voice.hornGate.gain, e.horn ? HORN_LEVEL : 0, now, (e.horn ? d.horn.attackS : d.horn.releaseS) / 3);
    }

    const l = this.listener;
    let cents = 0;
    if (e.inCabin) {
      setNodePosition(voice.panner, l.x, l.y, l.z);
    } else {
      setNodePosition(voice.panner, e.x, e.y, e.z);
      const va = VEHICLE_AUDIO;
      cents = ratioToCents(
        dopplerRatio(e.x, e.y, e.z, e.vx, e.vy, e.vz, l.x, l.y, l.z, l.vx, l.vy, l.vz, va.speedOfSound, va.dopplerClamp[0], va.dopplerClamp[1]),
      );
    }
    if (fresh || Math.abs(cents - voice.cents) > DETUNE_EPSILON_CENTS) {
      voice.cents = cents;
      const tau = VEHICLE_AUDIO.dopplerTau;
      glide(voice.osc.detune, cents, now, tau);
      const horns = voice.horns;
      for (let i = 0; i < horns.length; i++) {
        const h = horns[i];
        if (h) glide(h.detune, cents, now, tau);
      }
    }
  }

  private release(voice: Voice, now: number): void {
    const d = this.data;
    if (voice.manual && voice.tone === null) {
      // Manual wind-up let go: the rotor spins down toward minHz while fading.
      glide(voice.osc.frequency, d.manual.minHz, now, d.manual.fallS / 3);
      glide(voice.gain.gain, 0, now, d.manual.fallS / 3);
    } else {
      glide(voice.gain.gain, 0, now, RELEASE_TAU);
    }
    glide(voice.hornGate.gain, 0, now, d.horn.releaseS / 3);
    voice.emitterId = FREE;
    voice.tone = null;
    voice.manual = false;
    voice.horn = false;
    voice.inCabin = false;
    voice.cents = 0;
  }
}
