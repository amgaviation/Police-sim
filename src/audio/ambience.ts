import { createRng, type Rng } from '../core/rng';
import { AMBIENCE_DATA, type AmbienceData, type AmbienceLayer } from './ambienceData';
import { ambienceGains, nextChirpS, type AmbienceParams } from './ambienceMath';
import { glide, safeDisconnect } from './nodes';
import { createAudioStats, type AudioStats } from './sirens';

/**
 * City ambience beds (phase 9 design §5.5): one node chain per layer (traffic rumble, mains hum, wind, rain, birds,
 * crickets, water) summed into a shared low-pass that muffles the bed indoors and in a cabin. The graph is built
 * once on unlock; `update` only writes AudioParams, plus at most `MAX_CHIRPS` single-use chirp sources for birds.
 * Without a context every method is a no-op and nothing here ever throws.
 */

/** Layer gain glide (s). */
const GAIN_TAU = 0.5;
/** Shared low-pass glide (s). */
const FILTER_TAU = 0.3;
/** Open (no muffling) cutoff (Hz). */
const OPEN_LOWPASS_HZ = 20000;
/** A layer gain is rewritten only when its target moved by more than this. */
const GAIN_EPSILON = 1e-4;
/** Layer gain below which a layer counts as silent. */
const AUDIBLE = 0.001;
/** Chirp sweep: start / end frequency (Hz), length (s) and spacing between sweeps of one chirp (s). */
const CHIRP_FROM_HZ = 2500;
const CHIRP_TO_HZ = 4500;
const CHIRP_SWEEP_S = 0.08;
const CHIRP_STEP_S = 0.14;
/** Chirps live at once. */
const MAX_CHIRPS = 3;
/** Re-check period while no chirp is due (s). */
const IDLE_POLL_S = 1;

interface LayerNodes {
  readonly gain: GainNode;
}

export class AmbienceBed {
  private readonly data: AmbienceData;
  private readonly stats: AudioStats;
  private readonly rng: Rng = createRng('audio:ambience');
  private ctx: BaseAudioContext | null = null;
  private post: BiquadFilterNode | null = null;
  private layers: LayerNodes[] = [];
  private target = new Float32Array(0);
  private written = new Float32Array(0);
  private cutoff = OPEN_LOWPASS_HZ;
  /** The one looped noise source feeding every noise layer (each through its own filter): keeps the node count low. */
  private noiseSrc: AudioBufferSourceNode | null = null;
  /** Seconds until the next chirp of each layer, and whether that expiry is a real chirp (not an idle poll). */
  private chirpTimer = new Float64Array(0);
  private chirpDue = new Uint8Array(0);
  /** Context time each chirp slot ends. */
  private readonly chirpEnd = new Float64Array(MAX_CHIRPS);

  constructor(stats: AudioStats = createAudioStats(), data: AmbienceData = AMBIENCE_DATA) {
    this.stats = stats;
    this.data = data;
  }

  /** @internal Engine unlock: builds one node chain per layer and the shared post low-pass. */
  build(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer): void {
    if (this.ctx) return;
    this.ctx = ctx;
    const post = ctx.createBiquadFilter();
    post.type = 'lowpass';
    post.frequency.value = OPEN_LOWPASS_HZ;
    post.connect(out);
    this.post = post;
    this.cutoff = OPEN_LOWPASS_HZ;
    const n = this.data.layers.length;
    this.target = new Float32Array(n);
    this.written = new Float32Array(n);
    this.chirpTimer = new Float64Array(n);
    this.chirpDue = new Uint8Array(n);
    this.chirpEnd.fill(0);
    for (let i = 0; i < n; i++) {
      const layer = this.data.layers[i];
      if (!layer) continue;
      this.layers.push(this.buildLayer(ctx, post, noise, layer));
      this.chirpTimer[i] = IDLE_POLL_S;
    }
  }

  /** @internal Drops the graph (engine dispose). */
  detach(): void {
    if (this.post) safeDisconnect(this.post);
    try {
      this.noiseSrc?.stop();
    } catch {
      // already stopped
    }
    this.ctx = null;
    this.post = null;
    this.noiseSrc = null;
    this.layers = [];
    this.stats.ambienceLayers = 0;
  }

  /**
   * Per frame: glides each layer gain (tau 0.5 s) and the shared low-pass (indoor / cabin / open), and schedules bird
   * chirps (2-4 sine sweeps 2.5 -> 4.5 kHz of 80 ms, at most 3 live) from `createRng('audio:ambience')`. `dt` (s)
   * advances the chirp timers; the context time is read inside.
   */
  update(p: Readonly<AmbienceParams>, dt: number): void {
    const ctx = this.ctx;
    const post = this.post;
    if (!ctx || !post) return;
    try {
      const now = ctx.currentTime;
      const data = this.data;
      const target = this.target;
      ambienceGains(p, data, target);
      let audible = 0;
      for (let i = 0; i < this.layers.length; i++) {
        const t = target[i] ?? 0;
        if (t > AUDIBLE) audible++;
        if (Math.abs(t - (this.written[i] ?? 0)) > GAIN_EPSILON) {
          this.written[i] = t;
          const node = this.layers[i];
          if (node) glide(node.gain.gain, t, now, GAIN_TAU);
        }
      }
      this.stats.ambienceLayers = audible;

      let cut = OPEN_LOWPASS_HZ;
      if (p.indoor) cut = Math.min(cut, data.indoorLowpassHz);
      if (p.inCabin) cut = Math.min(cut, data.cabinLowpassHz);
      if (cut !== this.cutoff) {
        this.cutoff = cut;
        glide(post.frequency, cut, now, FILTER_TAU);
      }

      for (let i = 0; i < this.layers.length; i++) {
        const layer = data.layers[i];
        if (layer?.source !== 'chirps') continue;
        this.chirps(layer, i, dt, now);
      }
    } catch {
      // never throw from audio
    }
  }

  private buildLayer(ctx: BaseAudioContext, post: AudioNode, noise: AudioBuffer, layer: AmbienceLayer): LayerNodes {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(post);
    switch (layer.source) {
      case 'noise': {
        let src = this.noiseSrc;
        if (!src) {
          src = ctx.createBufferSource();
          src.buffer = noise;
          src.loop = true;
          const dur = noise.duration;
          src.start(0, dur > 0 ? dur * 0.43 : 0);
          this.noiseSrc = src;
        }
        const f = layer.filter;
        const filter = ctx.createBiquadFilter();
        if (f) {
          filter.type = f.type;
          filter.frequency.value = f.hz;
          filter.Q.value = f.q;
        }
        src.connect(filter);
        if (layer.lfoHz > 0) {
          // Amplitude 0.75 +- 0.25 (depth 0.5).
          const amp = ctx.createGain();
          amp.gain.value = 0.75;
          const lfo = ctx.createOscillator();
          lfo.type = 'sine';
          lfo.frequency.value = layer.lfoHz;
          const depth = ctx.createGain();
          depth.gain.value = 0.25;
          lfo.connect(depth);
          depth.connect(amp.gain);
          filter.connect(amp);
          amp.connect(gain);
          lfo.start();
        } else {
          filter.connect(gain);
        }
        break;
      }
      case 'hum': {
        const fundamental = ctx.createOscillator();
        fundamental.type = 'sine';
        fundamental.frequency.value = layer.hz;
        const second = ctx.createOscillator();
        second.type = 'sine';
        second.frequency.value = layer.hz * 2;
        const secondGain = ctx.createGain();
        secondGain.gain.value = 0.5;
        fundamental.connect(gain);
        second.connect(secondGain);
        secondGain.connect(gain);
        fundamental.start();
        second.start();
        break;
      }
      case 'crickets': {
        // tone x (0.5 + 0.5 square at amHz) x (0.5 + 0.5 square at 0.7 Hz)
        const tone = ctx.createOscillator();
        tone.type = 'sine';
        tone.frequency.value = layer.hz;
        const chop = ctx.createGain();
        chop.gain.value = 0.5;
        const gate = ctx.createGain();
        gate.gain.value = 0.5;
        const chopLfo = ctx.createOscillator();
        chopLfo.type = 'square';
        chopLfo.frequency.value = layer.amHz;
        const chopDepth = ctx.createGain();
        chopDepth.gain.value = 0.5;
        const gateLfo = ctx.createOscillator();
        gateLfo.type = 'square';
        gateLfo.frequency.value = 0.7;
        const gateDepth = ctx.createGain();
        gateDepth.gain.value = 0.5;
        chopLfo.connect(chopDepth);
        chopDepth.connect(chop.gain);
        gateLfo.connect(gateDepth);
        gateDepth.connect(gate.gain);
        tone.connect(chop);
        chop.connect(gate);
        gate.connect(gain);
        tone.start();
        chopLfo.start();
        gateLfo.start();
        break;
      }
      case 'chirps':
        // Event sources connect to `gain` on update.
        break;
    }
    return { gain };
  }

  private chirps(layer: AmbienceLayer, index: number, dt: number, now: number): void {
    const timer = (this.chirpTimer[index] ?? IDLE_POLL_S) - (dt > 0 ? dt : 0);
    if (timer > 0) {
      this.chirpTimer[index] = timer;
      return;
    }
    const level = layer.gain > 0 ? (this.target[index] ?? 0) / layer.gain : 0;
    if (this.chirpDue[index] === 1 && level > 0) this.spawnChirp(index, now);
    const wait = nextChirpS(this.rng, layer.ratePerS, level);
    if (Number.isFinite(wait)) {
      this.chirpTimer[index] = wait;
      this.chirpDue[index] = 1;
    } else {
      this.chirpTimer[index] = IDLE_POLL_S;
      this.chirpDue[index] = 0;
    }
  }

  /** One chirp: 2-4 sweeps on a single single-use oscillator; skipped while `MAX_CHIRPS` are live. */
  private spawnChirp(index: number, now: number): void {
    const ctx = this.ctx;
    const node = this.layers[index];
    if (!ctx || !node) return;
    let slot = -1;
    for (let s = 0; s < MAX_CHIRPS; s++) {
      if ((this.chirpEnd[s] ?? 0) <= now) {
        slot = s;
        break;
      }
    }
    if (slot < 0) return;
    const rng = this.rng;
    const sweeps = rng.nextInt(2, 4);
    const detune = rng.nextFloat(0.9, 1.1);
    const t0 = now + 0.01;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    for (let k = 0; k < sweeps; k++) {
      const ts = t0 + k * CHIRP_STEP_S;
      osc.frequency.setValueAtTime(CHIRP_FROM_HZ * detune, ts);
      osc.frequency.exponentialRampToValueAtTime(CHIRP_TO_HZ * detune, ts + CHIRP_SWEEP_S);
      env.gain.setValueAtTime(0, ts);
      env.gain.linearRampToValueAtTime(1, ts + 0.01);
      env.gain.linearRampToValueAtTime(0, ts + CHIRP_SWEEP_S);
    }
    const end = t0 + (sweeps - 1) * CHIRP_STEP_S + CHIRP_SWEEP_S + 0.02;
    this.chirpEnd[slot] = end;
    osc.connect(env);
    env.connect(node.gain);
    osc.onended = () => {
      safeDisconnect(osc);
      safeDisconnect(env);
    };
    osc.start(t0);
    osc.stop(end);
  }
}
