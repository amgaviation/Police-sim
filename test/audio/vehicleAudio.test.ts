import { beforeEach, describe, expect, it } from 'vitest';
import { SURFACE } from '../../src/world/ids';
import type { ListenerState } from '../../src/audio/nodes';
import { createAudioStats } from '../../src/audio/sirens';
import { VehicleAudio, type DrivenAudioState, type TrafficAudioSource } from '../../src/audio/vehicleAudio';
import { ENGINE_PROFILES, VEHICLE_AUDIO } from '../../src/audio/vehicleData';
import { engineCutoffHz, engineGain, firingHz, rpmFromSpeed } from '../../src/audio/vehicleMath';
import {
  fakeGraph,
  type FakeBiquad,
  type FakeContext,
  type FakeGain,
  type FakeOscillator,
  type FakePanner,
} from './fakeAudio';

const PROF = VEHICLE_AUDIO.engine.profiles;
const TIRES = VEHICLE_AUDIO.tires;
const TRAFFIC = VEHICLE_AUDIO.engine.traffic;

function driven(over: Partial<DrivenAudioState> = {}): DrivenAudioState {
  return {
    active: true, profile: 'car', rpm: 2500, throttle: 0.6, running: true, speed: 12, groundSpeed: 12, brake: 0,
    handbrake: false, absActive: false, surface: SURFACE.asphalt, airborne: false, inCabin: false, x: 5, y: 1, z: -3, ...over,
  };
}

function car(id: number, x: number, z: number, speed = 10): TrafficAudioSource {
  return { id, x, y: 0, z, speed };
}

interface Rig {
  ctx: FakeContext;
  va: VehicleAudio;
  listener: ListenerState;
  /** Oscillators: A, B, sub, lfo, squeal, then the traffic voices. */
  oscs: FakeOscillator[];
  /** Biquads: noise band-pass, engine low-pass, cabin low-pass, slide band-pass, crunch low-pass, then traffic low-passes. */
  biquads: FakeBiquad[];
  panners: FakePanner[];
  gains: FakeGain[];
  stats: ReturnType<typeof createAudioStats>;
  ac: BaseAudioContext;
  out: AudioNode;
  noise: AudioBuffer;
}

function rig(): Rig {
  const { ctx, ac, out, noise } = fakeGraph();
  const stats = createAudioStats();
  const va = new VehicleAudio(stats);
  const listener: ListenerState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  va.build(ac, out as unknown as AudioNode, noise, listener);
  return {
    ctx,
    va,
    listener,
    stats,
    ac,
    out: out as unknown as AudioNode,
    noise,
    oscs: ctx.nodesOf<FakeOscillator>('oscillator'),
    biquads: ctx.nodesOf<FakeBiquad>('biquad'),
    panners: ctx.nodesOf<FakePanner>('panner'),
    gains: ctx.nodesOf<FakeGain>('gain'),
  };
}

/** The gain node an oscillator feeds. */
function fedBy(r: Rig, osc: FakeOscillator): FakeGain {
  const g = r.gains.find((n) => osc.connections.includes(n));
  if (!g) throw new Error('no gain fed by the oscillator');
  return g;
}

/** Gain feeding the cabin low-pass whose input is the given source node (tire voices). */
function tireGains(r: Rig): { squeal: FakeGain; slide: FakeGain; crunch: FakeGain; engine: FakeGain } {
  const cabin = r.biquads[2];
  const into = r.gains.filter((g) => g.connections.includes(cabin));
  // creation order into the cabin low-pass: engine voice gain, squeal, slide, crunch
  const [engine, squeal, slide, crunch] = into;
  if (!engine || !squeal || !slide || !crunch) throw new Error('tire graph not as expected');
  return { engine, squeal, slide, crunch };
}

describe('VehicleAudio graph', () => {
  it('builds the driven voice, the tire voice and the traffic voices once', () => {
    const r = rig();
    const n = TRAFFIC.voices;
    // A, B, sub, lfo, squeal + one oscillator per traffic voice
    expect(r.oscs).toHaveLength(5 + n);
    expect(r.panners).toHaveLength(1 + n);
    expect(r.ctx.created['bufferSource']).toBe(1);
    expect(r.oscs.every((o) => o.started !== null)).toBe(true);
    expect(r.ctx.nodesOf('bufferSource').every((s) => (s as unknown as { loop: boolean }).loop)).toBe(true);
    // build is idempotent
    const total = r.ctx.totalCreated;
    r.va.build(r.ac, r.out, r.noise, r.listener);
    expect(r.ctx.totalCreated).toBe(total);
  });

  it('is a no-op before build and after detach', () => {
    const va = new VehicleAudio();
    expect(() => va.update(driven(), [car(1, 1, 1)], 1)).not.toThrow();
    const r = rig();
    r.va.detach();
    const writes = r.ctx.paramWrites;
    r.va.update(driven(), [car(1, 1, 1)], 1);
    expect(r.ctx.paramWrites).toBe(writes);
    expect(r.stats.engine).toBe(0);
    expect(r.stats.traffic).toBe(0);
  });

  it('keeps a fixed node count over 1000 updates while profiles, states and cars change', () => {
    const r = rig();
    const total = r.ctx.totalCreated;
    const cars: TrafficAudioSource[] = [];
    for (let i = 0; i < 8; i++) cars.push(car(i + 1, i * 12, 5));
    for (let f = 0; f < 1000; f++) {
      r.ctx.currentTime = f / 60;
      const id = ENGINE_PROFILES[Math.floor(f / 100) % ENGINE_PROFILES.length] ?? 'car';
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (c) {
          c.x = ((i * 12 + f * 0.7) % 150) - 30;
          c.speed = 5 + (i * 3 + f / 10) % 25;
        }
      }
      r.va.update(
        driven({
          active: f % 400 < 350,
          profile: id,
          rpm: 800 + (f % 500) * 8,
          throttle: (f % 100) / 100,
          running: f % 300 < 280,
          groundSpeed: 5 + (f % 40),
          speed: 5 + (f % 30),
          surface: f % 6,
          inCabin: f % 200 < 100,
          airborne: f % 350 === 0,
          handbrake: f % 90 === 0,
        }),
        cars,
        cars.length,
      );
    }
    expect(r.ctx.totalCreated).toBe(total);
  });
});

describe('driven engine voice', () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });

  it('runs the oscillators at the firing frequency, 2x and 1/2x, per profile', () => {
    for (const id of ENGINE_PROFILES) {
      const p = PROF[id];
      for (const rpm of [800, 2500, 6100]) {
        r.va.update(driven({ profile: id, rpm }), [], 0);
        const f = firingHz(rpm, p.cylinders);
        expect(r.oscs[0]?.frequency.target, `${id} A`).toBeCloseTo(f, 6);
        expect(r.oscs[1]?.frequency.target, `${id} B`).toBeCloseTo(f * 2, 6);
        expect(r.oscs[2]?.frequency.target, `${id} sub`).toBeCloseTo(f / 2, 6);
        expect(r.biquads[0]?.frequency.target, `${id} noise band`).toBeCloseTo(Math.min(12000, f * 2), 6);
      }
    }
  });

  it('retunes in place on a profile change (wave, sub gain, AM depth)', () => {
    r.va.update(driven({ profile: 'car' }), [], 0);
    expect(r.oscs[0]?.type).toBe(PROF.car.wave);
    r.va.update(driven({ profile: 'rotor' }), [], 0);
    expect(r.oscs[0]?.type).toBe(PROF.rotor.wave);
    expect(r.oscs[1]?.type).toBe(PROF.rotor.wave);
    const subGain = fedBy(r, r.oscs[2] as FakeOscillator);
    expect(subGain.gain.target).toBe(PROF.rotor.subGain);
    const lfoDepth = fedBy(r, r.oscs[3] as FakeOscillator);
    expect(lfoDepth.gain.target).toBeCloseTo(PROF.rotor.am / 2, 12);
    // the LFO runs at a quarter of the firing frequency
    r.va.update(driven({ profile: 'rotor', rpm: 1200 }), [], 0);
    expect(r.oscs[3]?.frequency.target).toBeCloseTo(firingHz(1200, PROF.rotor.cylinders) / 4, 9);
    r.va.update(driven({ profile: 'v8' }), [], 0);
    expect(lfoDepth.gain.target).toBe(0);
    expect(r.oscs[0]?.type).toBe(PROF.v8.wave);
  });

  it('sets the low-pass and the voice gain from rpm and throttle', () => {
    r.va.update(driven({ profile: 'diesel', rpm: 3000, throttle: 0.8 }), [], 0);
    const p = PROF.diesel;
    expect(r.biquads[1]?.frequency.target).toBeCloseTo(engineCutoffHz(p, 3000, 0.8), 9);
    const { engine } = tireGains(r);
    expect(engine.gain.target).toBeCloseTo(engineGain(p, VEHICLE_AUDIO.engine.idleGain, 0.8, true), 12);
    // not running: silent
    r.va.update(driven({ profile: 'diesel', running: false }), [], 0);
    expect(engine.gain.target).toBe(0);
    expect(r.stats.engine).toBe(0);
  });

  it('reports the engine in the stats while it runs', () => {
    r.va.update(driven(), [], 0);
    expect(r.stats.engine).toBe(1);
    r.va.update(driven({ active: false }), [], 0);
    expect(r.stats.engine).toBe(0);
  });

  it('glides every gain to 0 when inactive or without a profile', () => {
    r.va.update(driven({ surface: SURFACE.gravel, groundSpeed: 20 }), [], 0);
    const t = tireGains(r);
    expect(t.engine.gain.target).toBeGreaterThan(0);
    expect(t.crunch.gain.target).toBeGreaterThan(0);
    r.va.update(driven({ active: false }), [], 0);
    for (const g of [t.engine, t.squeal, t.slide, t.crunch]) expect(g.gain.target).toBe(0);
    r.va.update(driven({ profile: null }), [], 0);
    expect(t.engine.gain.target).toBe(0);
    // coming back
    r.va.update(driven(), [], 0);
    expect(t.engine.gain.target).toBeGreaterThan(0);
  });

  it('does not rewrite params while inactive', () => {
    r.va.update(driven({ active: false }), [], 0);
    const writes = r.ctx.paramWrites;
    r.va.update(driven({ active: false }), [], 0);
    expect(r.ctx.paramWrites).toBe(writes);
  });

  it('applies the cabin gain and the extra low-pass only in the cabin', () => {
    const cabin = r.biquads[2] as FakeBiquad;
    r.va.update(driven({ inCabin: false }), [], 0);
    expect(cabin.frequency.target).toBeGreaterThanOrEqual(20000);
    const open = tireGains(r).engine.gain.target;
    r.va.update(driven({ inCabin: true }), [], 0);
    expect(cabin.frequency.target).toBe(VEHICLE_AUDIO.engine.cabin.lowpassHz);
    expect(tireGains(r).engine.gain.target).toBeCloseTo(open * VEHICLE_AUDIO.engine.cabin.gain, 12);
    r.va.update(driven({ inCabin: false }), [], 0);
    expect(cabin.frequency.target).toBeGreaterThanOrEqual(20000);
    expect(tireGains(r).engine.gain.target).toBeCloseTo(open, 12);
  });

  it('puts the voice at the car, or at the listener in the cabin', () => {
    r.listener.x = 40;
    r.listener.y = 2;
    r.listener.z = -9;
    r.va.update(driven({ x: 5, y: 1, z: -3 }), [], 0);
    const p = r.panners[0] as FakePanner;
    expect([p.positionX.value, p.positionY.value, p.positionZ.value]).toEqual([5, 1, -3]);
    r.va.update(driven({ inCabin: true }), [], 0);
    expect([p.positionX.value, p.positionY.value, p.positionZ.value]).toEqual([40, 2, -9]);
    expect(p.refDistance).toBeGreaterThan(0);
  });
});

describe('tire voice', () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });

  it('squeals sliding on asphalt, with pitch following the slip', () => {
    r.va.update(driven({ speed: 10, groundSpeed: 14 }), [], 0);
    const t = tireGains(r);
    // lateral slip sqrt(14^2 - 10^2) = 9.8 m/s -> full squeal
    expect(t.squeal.gain.target).toBeCloseTo(TIRES.gain, 12);
    expect(t.slide.gain.target).toBeGreaterThan(0);
    expect(t.slide.gain.target).toBeLessThan(t.squeal.gain.target);
    const squeal = r.oscs[4] as FakeOscillator;
    expect(squeal.frequency.target).toBeGreaterThan(TIRES.squealHzMin);
    expect(squeal.frequency.target).toBeLessThanOrEqual(TIRES.squealHzMax);
  });

  it('squeals with the handbrake or locked brakes, and not when ABS works or when grip holds', () => {
    r.va.update(driven({ speed: 15, groundSpeed: 15, handbrake: true }), [], 0);
    expect(tireGains(r).squeal.gain.target).toBeGreaterThan(0);
    r.va.update(driven({ speed: 15, groundSpeed: 15, brake: 1 }), [], 0);
    expect(tireGains(r).squeal.gain.target).toBeGreaterThan(0);
    r.va.update(driven({ speed: 15, groundSpeed: 15, brake: 1, absActive: true }), [], 0);
    expect(tireGains(r).squeal.gain.target).toBe(0);
    r.va.update(driven({ speed: 15, groundSpeed: 15 }), [], 0);
    expect(tireGains(r).squeal.gain.target).toBe(0);
  });

  it('does not squeal on gravel, or in the air; the slide scales with the cabin', () => {
    r.va.update(driven({ speed: 10, groundSpeed: 14, surface: SURFACE.gravel }), [], 0);
    expect(tireGains(r).squeal.gain.target).toBe(0);
    expect(tireGains(r).slide.gain.target).toBe(0);
    r.va.update(driven({ speed: 10, groundSpeed: 14, airborne: true }), [], 0);
    expect(tireGains(r).squeal.gain.target).toBe(0);
    r.va.update(driven({ speed: 10, groundSpeed: 14, inCabin: true }), [], 0);
    expect(tireGains(r).squeal.gain.target).toBeCloseTo(TIRES.gain * VEHICLE_AUDIO.engine.cabin.gain, 12);
  });

  it('crunches on gravel (and dirt), not on asphalt or when airborne', () => {
    r.va.update(driven({ surface: SURFACE.gravel, groundSpeed: 15, speed: 15 }), [], 0);
    expect(tireGains(r).crunch.gain.target).toBeCloseTo(TIRES.gravelGain, 12);
    r.va.update(driven({ surface: SURFACE.dirt, groundSpeed: 15, speed: 15 }), [], 0);
    expect(tireGains(r).crunch.gain.target).toBeGreaterThan(0);
    r.va.update(driven({ surface: SURFACE.asphalt, groundSpeed: 15, speed: 15 }), [], 0);
    expect(tireGains(r).crunch.gain.target).toBe(0);
    r.va.update(driven({ surface: SURFACE.gravel, groundSpeed: 15, speed: 15, airborne: true }), [], 0);
    expect(tireGains(r).crunch.gain.target).toBe(0);
  });

  it('squeals even while the engine is off', () => {
    r.va.update(driven({ running: false, speed: 10, groundSpeed: 14 }), [], 0);
    expect(tireGains(r).squeal.gain.target).toBeGreaterThan(0);
  });
});

describe('traffic voices', () => {
  let r: Rig;
  /** Traffic panner / gain / oscillator / low-pass of voice i. */
  const voice = (i: number): { panner: FakePanner; gain: FakeGain; osc: FakeOscillator; lowpass: FakeBiquad } => {
    const osc = r.oscs[5 + i] as FakeOscillator;
    return {
      panner: r.panners[1 + i] as FakePanner,
      gain: r.gains.filter((g) => g.connections.includes(r.panners[1 + i]))[0] as FakeGain,
      osc,
      lowpass: r.biquads[5 + i] as FakeBiquad,
    };
  };
  const posX = (): number[] => [0, 1, 2].map((i) => voice(i).panner.positionX.value);
  const active = (): number => [0, 1, 2].filter((i) => voice(i).gain.gain.target > 0).length;

  beforeEach(() => {
    r = rig();
  });

  it('gives voices to the nearest cars within range and drops the rest', () => {
    // listener at the origin; maxDistanceM 60
    const cars = [car(1, 50, 0), car(2, 10, 0), car(3, 30, 0), car(4, 20, 0), car(5, 70, 0), car(6, 0, 59)];
    r.va.update(driven({ active: false }), cars, cars.length);
    expect(r.stats.traffic).toBe(TRAFFIC.voices);
    expect(active()).toBe(3);
    expect([...posX()].sort((a, b) => a - b)).toEqual([10, 20, 30]);
    expect(posX()).not.toContain(70);
    expect(posX()).not.toContain(50);
    expect(r.panners.slice(1).some((p) => p.positionZ.value === 59)).toBe(false);
  });

  it('uses the XZ distance to the listener and ignores cars beyond maxDistanceM', () => {
    r.listener.x = 100;
    r.listener.z = 100;
    const cars = [car(1, 100, 100 + TRAFFIC.maxDistanceM - 1), car(2, 100 + TRAFFIC.maxDistanceM + 1, 100), car(3, 0, 0)];
    r.va.update(driven({ active: false }), cars, cars.length);
    expect(r.stats.traffic).toBe(1);
    expect(active()).toBe(1);
  });

  it('keeps a voice on its car while selected and frees voices of cars that leave', () => {
    const a = car(1, 10, 0);
    const b = car(2, 20, 0);
    const c = car(3, 30, 0);
    r.va.update(driven({ active: false }), [a, b, c], 3);
    const where = (x: number): number => [0, 1, 2].find((i) => voice(i).panner.positionX.value === x) ?? -1;
    const va = where(10);
    const vb = where(20);
    const vc = where(30);
    expect(new Set([va, vb, vc]).size).toBe(3);
    // order and distance change; same voices follow the same cars
    a.x = 40;
    c.x = 5;
    r.va.update(driven({ active: false }), [c, b, a], 3);
    expect(where(40)).toBe(va);
    expect(where(5)).toBe(vc);
    expect(where(20)).toBe(vb);
    // b leaves the range: its voice fades out
    b.x = 500;
    r.va.update(driven({ active: false }), [a, b, c], 3);
    expect(voice(vb).gain.gain.target).toBe(0);
    expect(r.stats.traffic).toBe(2);
    // a new car takes the free voice
    const d = car(4, 15, 0);
    r.va.update(driven({ active: false }), [a, b, c, d], 4);
    expect(where(15)).toBe(vb);
    expect(voice(vb).gain.gain.target).toBeGreaterThan(0);
    // everything gone
    r.va.update(driven({ active: false }), [], 0);
    expect(active()).toBe(0);
    expect(r.stats.traffic).toBe(0);
  });

  it('tunes each voice from the car speed: frequency, low-pass and gain', () => {
    const p = PROF[TRAFFIC.profile];
    r.va.update(driven({ active: false }), [car(1, 10, 0, 20)], 1);
    const v = [0, 1, 2].map(voice).find((x) => x.panner.positionX.value === 10);
    expect(v).toBeDefined();
    const rpm = rpmFromSpeed(20, TRAFFIC);
    expect(v?.osc.frequency.target).toBeCloseTo(firingHz(rpm, p.cylinders), 6);
    expect(v?.lowpass.frequency.target).toBeCloseTo(engineCutoffHz(p, rpm, 0.4), 9);
    expect(v?.gain.gain.target).toBeCloseTo(0.25 * engineGain(p, VEHICLE_AUDIO.engine.idleGain, 0.4, true), 12);
    // a stopped car idles
    r.va.update(driven({ active: false }), [car(1, 10, 0, 0)], 1);
    expect(v?.osc.frequency.target).toBeCloseTo(firingHz(TRAFFIC.idleRpm, p.cylinders), 6);
  });

  it('honours the count argument', () => {
    const cars = [car(1, 10, 0), car(2, 20, 0), car(3, 30, 0)];
    r.va.update(driven({ active: false }), cars, 1);
    expect(r.stats.traffic).toBe(1);
  });
});
