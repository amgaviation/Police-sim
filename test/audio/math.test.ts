import { describe, expect, it } from 'vitest';
import { SIREN_DATA, SIREN_TONES, parseSirenData } from '../../src/audio/data';
import { chooseNearest, distanceGain, lfoValue, sirenFrequency, type SirenEmitter } from '../../src/audio/math';
import { fillNoise, softClipCurve } from '../../src/audio/nodes';
import sirensJson from '../../src/data/audio/sirens.json';

function emitter(id: number, x: number, z: number, extra: Partial<SirenEmitter> = {}): SirenEmitter {
  return { id, x, y: 1, z, vx: 0, vy: 0, vz: 0, tone: 'wail', horn: false, manual: false, inCabin: false, ...extra };
}

describe('sirens.json', () => {
  it('validates and matches the design table', () => {
    expect(SIREN_DATA.voices).toBe(4);
    expect(SIREN_DATA.maxAudibleM).toBe(700);
    expect(SIREN_DATA.tones.wail).toEqual({ lowHz: 650, highHz: 1500, periodS: 4.5, shape: 'triangle' });
    expect(SIREN_DATA.panner).toEqual({ model: 'inverse', refDistance: 12, rolloff: 1.1, maxDistance: 900 });
  });

  it('names the file and field on bad data', () => {
    const bad = JSON.parse(JSON.stringify(sirensJson)) as { tones: { yelp: { shape: string } } };
    bad.tones.yelp.shape = 'zigzag';
    expect(() => parseSirenData(bad)).toThrow(/sirens\.json: tones\.yelp\.shape/);
    const inverted = JSON.parse(JSON.stringify(sirensJson)) as { tones: { hilo: { highHz: number } } };
    inverted.tones.hilo.highHz = 100;
    expect(() => parseSirenData(inverted)).toThrow(/tones\.hilo\.highHz/);
    expect(() => parseSirenData({ ...sirensJson, version: 2 })).toThrow(/version/);
  });
});

describe('lfoValue', () => {
  it('follows the Web Audio periodic wave shapes', () => {
    expect(lfoValue('triangle', 0)).toBe(0);
    expect(lfoValue('triangle', 0.25)).toBe(1);
    expect(lfoValue('triangle', 0.75)).toBe(-1);
    expect(lfoValue('sawtooth', 0)).toBe(0);
    expect(lfoValue('sawtooth', 0.49)).toBeCloseTo(0.98);
    expect(lfoValue('sawtooth', 0.5)).toBe(-1);
    expect(lfoValue('square', 0.1)).toBe(1);
    expect(lfoValue('square', 0.6)).toBe(-1);
    expect(lfoValue('triangle', 1.25)).toBe(1);
  });
});

describe('sirenFrequency', () => {
  it('stays within [lowHz, highHz] and reaches both ends for every tone', () => {
    for (const tone of SIREN_TONES) {
      const spec = SIREN_DATA.tones[tone];
      let min = Infinity;
      let max = -Infinity;
      const steps = 4000;
      for (let i = 0; i <= steps; i++) {
        const f = sirenFrequency(tone, (i / steps) * spec.periodS * 2);
        min = Math.min(min, f);
        max = Math.max(max, f);
      }
      expect(min, tone).toBeGreaterThanOrEqual(spec.lowHz - 1e-6);
      expect(max, tone).toBeLessThanOrEqual(spec.highHz + 1e-6);
      expect(max - min, tone).toBeGreaterThan((spec.highHz - spec.lowHz) * 0.98);
    }
  });

  it('is periodic with the tone period', () => {
    for (const tone of SIREN_TONES) {
      const p = SIREN_DATA.tones[tone].periodS;
      for (const t of [0.013, 0.1, 0.27, 1.7]) {
        expect(sirenFrequency(tone, t + p), tone).toBeCloseTo(sirenFrequency(tone, t), 6);
        expect(sirenFrequency(tone, t + 3 * p), tone).toBeCloseTo(sirenFrequency(tone, t), 6);
      }
    }
  });

  it('wail sweeps up then down, yelp ramps up, hi-lo alternates', () => {
    const wail = SIREN_DATA.tones.wail;
    expect(sirenFrequency('wail', 0)).toBe((wail.lowHz + wail.highHz) / 2);
    expect(sirenFrequency('wail', wail.periodS / 4)).toBe(wail.highHz);
    expect(sirenFrequency('wail', (3 * wail.periodS) / 4)).toBe(wail.lowHz);
    const yelp = SIREN_DATA.tones.yelp.periodS;
    expect(sirenFrequency('yelp', yelp * 0.1)).toBeLessThan(sirenFrequency('yelp', yelp * 0.3));
    expect(sirenFrequency('yelp', yelp * 0.6)).toBeLessThan(sirenFrequency('yelp', yelp * 0.9));
    const hilo = SIREN_DATA.tones.hilo;
    expect(sirenFrequency('hilo', hilo.periodS * 0.2)).toBe(hilo.highHz);
    expect(sirenFrequency('hilo', hilo.periodS * 0.7)).toBe(hilo.lowHz);
  });
});

describe('distanceGain', () => {
  const formula = (d: number, ref: number, roll: number): number => ref / (ref + roll * (Math.max(d, ref) - ref));

  it('matches the Web Audio inverse formula', () => {
    for (const d of [12, 13, 50, 100, 333, 700, 899]) {
      expect(distanceGain(d, 12, 1.1, 900)).toBeCloseTo(formula(d, 12, 1.1), 12);
    }
    expect(distanceGain(24, 12, 1, 900)).toBeCloseTo(0.5, 12);
  });

  it('clamps below ref to 1 and above max to the max-distance gain', () => {
    expect(distanceGain(0, 12, 1.1, 900)).toBe(1);
    expect(distanceGain(5, 12, 1.1, 900)).toBe(1);
    expect(distanceGain(5000, 12, 1.1, 900)).toBeCloseTo(formula(900, 12, 1.1), 12);
    expect(distanceGain(100, 12, 0, 900)).toBe(1);
    expect(distanceGain(100, 0, 1, 900)).toBe(0);
  });

  it('decreases monotonically with distance', () => {
    let last = 2;
    for (let d = 0; d < 1000; d += 7) {
      const g = distanceGain(d, 12, 1.1, 900);
      expect(g).toBeLessThanOrEqual(last);
      last = g;
    }
  });
});

describe('chooseNearest', () => {
  const out = new Int32Array(8);

  it('returns the nearest sounding emitters, nearest first', () => {
    const list = [emitter(10, 300, 0), emitter(11, 10, 0), emitter(12, 0, 50), emitter(13, -120, 0), emitter(14, 0, -5)];
    const n = chooseNearest(list, list.length, 0, 0, 4, 700, out);
    expect(n).toBe(4);
    expect(Array.from(out.subarray(0, n))).toEqual([4, 1, 2, 3]);
  });

  it('respects count, capacity and maxDist', () => {
    const list = [emitter(1, 10, 0), emitter(2, 20, 0), emitter(3, 800, 0), emitter(4, 5, 0)];
    expect(chooseNearest(list, 3, 0, 0, 4, 700, out)).toBe(2);
    expect(Array.from(out.subarray(0, 2))).toEqual([0, 1]);
    expect(chooseNearest(list, 4, 0, 0, 2, 700, out)).toBe(2);
    expect(Array.from(out.subarray(0, 2))).toEqual([3, 0]);
    expect(chooseNearest(list, 4, 0, 0, 0, 700, out)).toBe(0);
    expect(chooseNearest(list, 4, 0, 0, 4, 15, out)).toBe(2);
    expect(chooseNearest(list, 4, 0, 0, 4, 700, new Int32Array(1))).toBe(1);
  });

  it('measures from the listener in XZ only', () => {
    const list = [emitter(1, 100, 100, { y: 500 }), emitter(2, 90, 90)];
    expect(chooseNearest(list, 2, 100, 100, 1, 700, out)).toBe(1);
    expect(out[0]).toBe(0);
  });

  it('breaks ties by index', () => {
    const list = [emitter(1, 10, 0), emitter(2, -10, 0), emitter(3, 0, 10), emitter(4, 0, -10)];
    expect(chooseNearest(list, 4, 0, 0, 3, 700, out)).toBe(3);
    expect(Array.from(out.subarray(0, 3))).toEqual([0, 1, 2]);
  });

  it('skips silent emitters and puts in-cabin emitters first', () => {
    const list = [
      emitter(1, 5, 0, { tone: null }),
      emitter(2, 50, 0, { tone: null, horn: true }),
      emitter(3, 40, 0, { tone: null, manual: true }),
      emitter(4, 2000, 0, { inCabin: true }),
    ];
    const n = chooseNearest(list, list.length, 0, 0, 4, 700, out);
    expect(Array.from(out.subarray(0, n))).toEqual([3, 2, 1]);
  });

  it('handles empty input and sparse arrays', () => {
    expect(chooseNearest([], 0, 0, 0, 4, 700, out)).toBe(0);
    expect(chooseNearest([emitter(1, 1, 1)], 5, 0, 0, 4, 700, out)).toBe(1);
  });
});

describe('noise and curve helpers', () => {
  it('fills deterministic noise in [-1, 1)', () => {
    const a = new Float32Array(4096);
    const b = new Float32Array(4096);
    fillNoise(a, 42);
    fillNoise(b, 42);
    expect(a).toEqual(b);
    let sum = 0;
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(Math.abs(sum / a.length)).toBeLessThan(0.05);
    fillNoise(b, 43);
    expect(a).not.toEqual(b);
  });

  it('builds a symmetric soft-clip curve ending at +-1', () => {
    const c = softClipCurve(101);
    expect(c[0]).toBeCloseTo(-1);
    expect(c[100]).toBeCloseTo(1);
    expect(c[50]).toBeCloseTo(0);
    expect(c[25]).toBeCloseTo(-(c[75] ?? 0));
  });
});
