import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { dopplerRatio, ratioToCents, type SirenEmitter } from '../../src/audio/math';
import { SIREN_DATA } from '../../src/audio/data';
import { VEHICLE_AUDIO } from '../../src/audio/vehicleData';
import { fakeFactory, type FakeContext, type FakeOscillator } from './fakeAudio';

function emitter(id: number, x: number, z: number, extra: Partial<SirenEmitter> = {}): SirenEmitter {
  return { id, x, y: 1, z, vx: 0, vy: 0, vz: 0, tone: 'wail', horn: false, manual: false, inCabin: false, ...extra };
}

describe('dopplerRatio', () => {
  it('an approaching source at 30 m/s raises the pitch by 343 / 313', () => {
    // source 100 m away on +x moving toward the listener at the origin
    expect(dopplerRatio(100, 0, 0, -30, 0, 0, 0, 0, 0, 0, 0, 0)).toBeCloseTo(343 / 313, 9);
  });

  it('a receding source at 30 m/s lowers the pitch by 343 / 373', () => {
    expect(dopplerRatio(100, 0, 0, 30, 0, 0, 0, 0, 0, 0, 0, 0)).toBeCloseTo(343 / 373, 9);
  });

  it('perpendicular motion gives 1', () => {
    expect(dopplerRatio(100, 0, 0, 0, 0, 30, 0, 0, 0, 0, 0, 0)).toBeCloseTo(1, 12);
    expect(dopplerRatio(0, 0, 100, 30, 0, 0, 0, 0, 0, 0, 0, 0)).toBeCloseTo(1, 12);
  });

  it('a listener moving toward a still source at 20 m/s gives 363 / 343', () => {
    expect(dopplerRatio(100, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 0)).toBeCloseTo(363 / 343, 9);
    // moving away
    expect(dopplerRatio(100, 0, 0, 0, 0, 0, 0, 0, 0, -20, 0, 0)).toBeCloseTo(323 / 343, 9);
  });

  it('combines source and listener motion and works in 3D', () => {
    expect(dopplerRatio(100, 0, 0, -30, 0, 0, 0, 0, 0, 20, 0, 0)).toBeCloseTo(363 / 313, 9);
    // 3-4-5 triangle: only the component along the line of sight counts
    expect(dopplerRatio(30, 40, 0, -30, -40, 0, 0, 0, 0, 0, 0, 0)).toBeCloseTo(343 / (343 - 50), 9);
    expect(dopplerRatio(0, 40, 30, 0, 0, 0, 0, 0, 0, 0, 24, 18, 340)).toBeCloseTo((340 + 30) / 340, 9);
  });

  it('clamps to [min, max] and survives supersonic sources', () => {
    expect(dopplerRatio(100, 0, 0, -300, 0, 0, 0, 0, 0, 0, 0, 0)).toBe(2);
    expect(dopplerRatio(100, 0, 0, -400, 0, 0, 0, 0, 0, 0, 0, 0)).toBe(2);
    expect(dopplerRatio(100, 0, 0, 400, 0, 0, 0, 0, 0, 0, 0, 0)).toBe(0.5);
    expect(dopplerRatio(100, 0, 0, -300, 0, 0, 0, 0, 0, 0, 0, 0, 343, 0.5, 1.5)).toBe(1.5);
    expect(dopplerRatio(100, 0, 0, 0, 0, 0, 0, 0, 0, -300, 0, 0, 343, 0.9, 2)).toBe(0.9);
  });

  it('is 1 at the same place or with no velocity', () => {
    expect(dopplerRatio(1, 2, 3, 50, 0, 0, 1, 2, 3, 0, 0, 0)).toBe(1);
    expect(dopplerRatio(1, 2, 3, 50, 0, 0, 1.001, 2, 3, 0, 0, 0)).toBe(1);
    expect(dopplerRatio(10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)).toBe(1);
    expect(dopplerRatio(Number.NaN, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0)).toBe(1);
  });
});

describe('ratioToCents', () => {
  it('is 1200 * log2(ratio)', () => {
    expect(ratioToCents(2)).toBeCloseTo(1200, 9);
    expect(ratioToCents(1)).toBe(0);
    expect(ratioToCents(0.5)).toBeCloseTo(-1200, 9);
    expect(ratioToCents(343 / 313)).toBeCloseTo(1200 * Math.log2(343 / 313), 9);
  });
});

/** Siren oscillators of voice `v`: [siren, lfo, horn, horn] (creation order of the siren bank). */
function voiceOscs(ctx: FakeContext, v: number): { siren: FakeOscillator; horns: FakeOscillator[] } {
  const per = 2 + SIREN_DATA.horn.freqsHz.length;
  const all = ctx.nodesOf<FakeOscillator>('oscillator').slice(v * per, (v + 1) * per);
  return { siren: all[0] as FakeOscillator, horns: all.slice(2) };
}

function unlocked(): { engine: AudioEngine; ctx: FakeContext } {
  const { ctx, factory } = fakeFactory();
  const engine = new AudioEngine({ contextFactory: factory });
  engine.unlock();
  return { engine, ctx };
}

describe('siren Doppler', () => {
  const [lo, hi] = VEHICLE_AUDIO.dopplerClamp;

  it('writes the detune of the siren and every horn oscillator', () => {
    const { engine, ctx } = unlocked();
    engine.setListener(0, 1, 0, 0, 0, -1, 0, 1, 0);
    engine.setListenerVelocity(0, 0, 0);
    // 100 m away on +x, driving toward the listener at 30 m/s
    engine.sirens.update([emitter(1, 100, 0, { vx: -30, horn: true })], 1, 0, 0);
    const expected = ratioToCents(343 / 313);
    const { siren, horns } = voiceOscs(ctx, 0);
    expect(siren.detune.target).toBeCloseTo(expected, 6);
    expect(horns).toHaveLength(SIREN_DATA.horn.freqsHz.length);
    for (const h of horns) expect(h.detune.target).toBeCloseTo(expected, 6);
    expect(siren.detune.events.some((e) => e.kind === 'setTargetAtTime')).toBe(true);
  });

  it('follows the receding side and the listener velocity', () => {
    const { engine, ctx } = unlocked();
    engine.setListener(0, 1, 0, 0, 0, -1, 0, 1, 0);
    engine.sirens.update([emitter(1, 100, 0, { vx: 30 })], 1, 0, 0);
    expect(voiceOscs(ctx, 0).siren.detune.target).toBeCloseTo(ratioToCents(343 / 373), 6);
    engine.setListenerVelocity(20, 0, 0);
    engine.sirens.update([emitter(1, 100, 0, { vx: 0 })], 1, 0, 0);
    expect(voiceOscs(ctx, 0).siren.detune.target).toBeCloseTo(ratioToCents(363 / 343), 6);
  });

  it('clamps with the data clamp', () => {
    const { engine, ctx } = unlocked();
    engine.setListener(0, 1, 0, 0, 0, -1, 0, 1, 0);
    engine.sirens.update([emitter(1, 100, 0, { vx: -340 })], 1, 0, 0);
    expect(voiceOscs(ctx, 0).siren.detune.target).toBeCloseTo(ratioToCents(hi), 6);
    engine.sirens.update([emitter(1, 100, 0, { vx: 400 })], 1, 0, 0);
    expect(voiceOscs(ctx, 0).siren.detune.target).toBeCloseTo(ratioToCents(lo), 6);
  });

  it('uses 0 cents in the cabin, whatever the velocities', () => {
    const { engine, ctx } = unlocked();
    engine.setListener(0, 1, 0, 0, 0, -1, 0, 1, 0);
    engine.setListenerVelocity(0, 0, -30);
    engine.sirens.update([emitter(1, 100, 0, { vx: -30, inCabin: true, horn: true })], 1, 0, 0);
    const { siren, horns } = voiceOscs(ctx, 0);
    expect(siren.detune.target).toBe(0);
    for (const h of horns) expect(h.detune.target).toBe(0);
  });

  it('drops back to 0 cents when the siren reaches a stopped car and when a voice is reused', () => {
    const { engine, ctx } = unlocked();
    engine.setListener(0, 1, 0, 0, 0, -1, 0, 1, 0);
    const e = emitter(1, 100, 0, { vx: -30 });
    engine.sirens.update([e], 1, 0, 0);
    expect(voiceOscs(ctx, 0).siren.detune.target).not.toBe(0);
    e.vx = 0;
    engine.sirens.update([e], 1, 0, 0);
    expect(voiceOscs(ctx, 0).siren.detune.target).toBe(0);
    // another emitter takes the voice after a release
    e.vx = -30;
    engine.sirens.update([e], 1, 0, 0);
    engine.sirens.update([], 0, 0, 0);
    engine.sirens.update([emitter(2, 100, 0, { vx: 0 })], 1, 0, 0);
    expect(voiceOscs(ctx, 0).siren.detune.target).toBe(0);
  });

  it('ignores non-finite listener velocities', () => {
    const { engine, ctx } = unlocked();
    engine.setListener(0, 1, 0, 0, 0, -1, 0, 1, 0);
    engine.setListenerVelocity(Number.NaN, Number.POSITIVE_INFINITY, 0);
    engine.sirens.update([emitter(1, 100, 0)], 1, 0, 0);
    expect(voiceOscs(ctx, 0).siren.detune.target).toBe(0);
  });

  it('creates zero nodes over 1000 updates with moving emitters and listener', () => {
    const { engine, ctx } = unlocked();
    const list: SirenEmitter[] = [];
    for (let i = 0; i < 6; i++) list.push(emitter(100 + i, i * 40, 20, { tone: (['wail', 'yelp', 'phaser', 'hilo'] as const)[i % 4], horn: i % 2 === 0 }));
    const before = ctx.totalCreated;
    for (let f = 0; f < 1000; f++) {
      ctx.currentTime = f / 60;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e) continue;
        e.x += 0.5 * Math.cos(f / 50 + i);
        e.vx = 30 * Math.cos(f / 50 + i);
        e.vz = 10 * Math.sin(f / 30 + i);
        e.inCabin = i === 1;
      }
      engine.setListener(0, 1, 0, 0, 0, -1, 0, 1, 0);
      engine.setListenerVelocity(15 * Math.sin(f / 40), 0, 5);
      engine.sirens.update(list, list.length, 0, 0);
    }
    expect(ctx.totalCreated).toBe(before);
  });
});
