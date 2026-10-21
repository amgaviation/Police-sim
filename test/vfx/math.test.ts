import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { VFX_DATA } from '../../src/render/vfx/data';
import {
  basisFromForward,
  coneBoost,
  emitSpec,
  nearestN,
  particleAt,
  randomDirection,
  ringRanges,
  tapeOffset,
  tapePhase,
  tapeWind,
  wetParams,
  type EmitSpec,
  type WetParams,
} from '../../src/render/vfx/math';
import { VFX_PARTICLE_KINDS } from '../../src/render/vfx/types';

describe('particleAt', () => {
  it('is the start at age 0 and ballistic afterwards', () => {
    const out = [0, 0, 0];
    expect(particleAt([1, 2, 3], [4, 5, 6], -9.8, 0, out)).toEqual([1, 2, 3]);
    particleAt([1, 2, 3], [4, 5, 6], -9.8, 2, out);
    expect(out[0]).toBeCloseTo(1 + 8, 12);
    expect(out[1]).toBeCloseTo(2 + 10 - 0.5 * 9.8 * 4, 12);
    expect(out[2]).toBeCloseTo(3 + 12, 12);
  });

  it('applies gravity on the vertical axis only', () => {
    const out = new Float32Array(3);
    particleAt([0, 0, 0], [0, 0, 0], -10, 1, out);
    expect(Array.from(out)).toEqual([0, -5, 0]);
  });
});

describe('ringRanges', () => {
  const out = new Int32Array(4);

  it('returns no range for an empty write', () => {
    expect(ringRanges(3, 0, 10, out)).toBe(0);
    expect(ringRanges(3, -2, 10, out)).toBe(0);
    expect(ringRanges(3, 4, 0, out)).toBe(0);
  });

  it('returns one range inside the buffer', () => {
    expect(ringRanges(2, 3, 10, out)).toBe(1);
    expect([out[0], out[1]]).toEqual([2, 3]);
    expect(ringRanges(7, 3, 10, out)).toBe(1);
    expect([out[0], out[1]]).toEqual([7, 3]);
  });

  it('splits a write that wraps into two ranges', () => {
    expect(ringRanges(8, 5, 10, out)).toBe(2);
    expect(Array.from(out)).toEqual([8, 2, 0, 3]);
    expect(ringRanges(9, 2, 10, out)).toBe(2);
    expect(Array.from(out)).toEqual([9, 1, 0, 1]);
  });

  it('normalises the head and covers the whole buffer when full', () => {
    expect(ringRanges(13, 2, 10, out)).toBe(1);
    expect([out[0], out[1]]).toEqual([3, 2]);
    expect(ringRanges(4, 10, 10, out)).toBe(1);
    expect([out[0], out[1]]).toEqual([0, 10]);
    expect(ringRanges(4, 99, 10, out)).toBe(1);
    expect([out[0], out[1]]).toEqual([0, 10]);
  });
});

describe('emitSpec', () => {
  const draw = (seed: string, kind: (typeof VFX_PARTICLE_KINDS)[number], n: number): EmitSpec[] => {
    const rng = createRng(seed);
    const spec: EmitSpec = { count: 0, speed: 0, life: 0 };
    const out: EmitSpec[] = [];
    for (let i = 0; i < n; i++) out.push({ ...emitSpec(kind, rng, spec) });
    return out;
  };

  it('is deterministic per seed and differs between seeds', () => {
    expect(draw('vfx:test', 'spark', 20)).toEqual(draw('vfx:test', 'spark', 20));
    expect(draw('vfx:test', 'spark', 20)).not.toEqual(draw('vfx:other', 'spark', 20));
  });

  it('stays inside the ranges of every kind', () => {
    for (const kind of VFX_PARTICLE_KINDS) {
      const k = VFX_DATA.particles.kinds[kind];
      for (const s of draw(`vfx:range:${kind}`, kind, 200)) {
        expect(Number.isInteger(s.count)).toBe(true);
        expect(s.count).toBeGreaterThanOrEqual(k.count[0]);
        expect(s.count).toBeLessThanOrEqual(k.count[1]);
        expect(s.speed).toBeGreaterThanOrEqual(k.speed[0]);
        expect(s.speed).toBeLessThan(k.speed[1]);
        expect(s.life).toBeGreaterThanOrEqual(k.lifeS[0]);
        expect(s.life).toBeLessThan(k.lifeS[1]);
      }
    }
  });
});

describe('randomDirection', () => {
  it('gives unit vectors, upward for the hemisphere', () => {
    const rng = createRng('vfx:dir');
    const v = [0, 0, 0];
    let belowSphere = 0;
    for (let i = 0; i < 300; i++) {
      randomDirection(rng, true, v);
      expect(Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0)).toBeCloseTo(1, 9);
      expect(v[1]).toBeGreaterThanOrEqual(0);
      randomDirection(rng, false, v);
      if ((v[1] ?? 0) < 0) belowSphere++;
    }
    expect(belowSphere).toBeGreaterThan(50);
  });
});

describe('tapeOffset', () => {
  const tape = VFX_DATA.tape;

  it('is zero at the post (z = 0) and at the far end (z = -3) at any time, wind and phase', () => {
    for (const t of [0, 0.37, 12.5, 599.9]) {
      for (const wind of [0.15, 0.6, 1]) {
        for (const phase of [0, 1.3, -40, 77]) {
          expect(Math.abs(tapeOffset(0, t, wind, phase))).toBeLessThan(1e-12);
          expect(Math.abs(tapeOffset(-3, t, wind, phase))).toBeLessThan(1e-12);
        }
      }
    }
  });

  it('is bounded by the amplitude times the wind factor', () => {
    let peak = 0;
    for (let z = -3; z <= 0; z += 0.05) {
      for (let t = 0; t < 4; t += 0.05) {
        const o = Math.abs(tapeOffset(z, t, 1, 0.8));
        peak = Math.max(peak, o);
        expect(o).toBeLessThanOrEqual(tape.amplitudeM + 1e-12);
        expect(Math.abs(tapeOffset(z, t, 0.4, 0.8))).toBeLessThanOrEqual(tape.amplitudeM * 0.4 + 1e-12);
      }
    }
    expect(peak).toBeGreaterThan(tape.amplitudeM * 0.8);
  });

  it('matches the shader formula and is periodic in the flutter frequency', () => {
    const z = -1.2;
    const t = 3.1;
    const expected =
      tape.amplitudeM * 0.7 * Math.sin(2 * Math.PI * tape.freqHz * t + z * tape.waveK + 0.5) * Math.sin(Math.PI * (-z / 3));
    expect(tapeOffset(z, t, 0.7, 0.5)).toBeCloseTo(expected, 12);
    expect(tapeOffset(z, t + 1 / tape.freqHz, 0.7, 0.5)).toBeCloseTo(tapeOffset(z, t, 0.7, 0.5), 9);
    // The 600 s clock wrap is seamless for the default frequency.
    expect(tape.freqHz * 600).toBe(Math.round(tape.freqHz * 600));
  });

  it('maps wind speed to the clamped factor and phases by position', () => {
    expect(tapeWind(0)).toBe(0.15);
    expect(tapeWind(tape.windFull / 2)).toBeCloseTo(0.5, 12);
    expect(tapeWind(tape.windFull)).toBe(1);
    expect(tapeWind(100)).toBe(1);
    expect(tapePhase(10, 20)).toBeCloseTo(10 * 0.37 + 20 * 0.61, 12);
  });
});

describe('wetParams', () => {
  const out: WetParams = { w: 0, groundRoughness: 0, markingsRoughness: 0, groundTint: 1 };
  const wet = VFX_DATA.wet;

  it('is dry at 0 and fully wet at 1', () => {
    wetParams(0, 0, 0.8, out);
    expect(out).toEqual({ w: 0, groundRoughness: wet.dryRoughness, markingsRoughness: 0.8, groundTint: 1 });
    wetParams(1, 0, 0.8, out);
    expect(out.w).toBe(1);
    expect(out.groundRoughness).toBeCloseTo(wet.wetRoughness, 12);
    expect(out.markingsRoughness).toBeCloseTo(wet.markingsWetRoughness, 12);
    expect(out.groundTint).toBeCloseTo(1 - wet.darken, 12);
  });

  it('lerps in between and snow cover dries it', () => {
    wetParams(0.5, 0, 0.8, out);
    expect(out.groundRoughness).toBeCloseTo((wet.dryRoughness + wet.wetRoughness) / 2, 12);
    expect(out.groundTint).toBeCloseTo(1 - wet.darken * 0.5, 12);
    wetParams(1, 0.5, 0.8, out);
    expect(out.w).toBeCloseTo(0.5, 12);
    wetParams(1, 1, 0.8, out);
    expect(out.w).toBe(0);
    expect(out.groundRoughness).toBe(wet.dryRoughness);
  });

  it('clamps out-of-range inputs', () => {
    wetParams(3, -1, 0.8, out);
    expect(out.w).toBe(1);
    wetParams(-2, 0, 0.8, out);
    expect(out.w).toBe(0);
  });
});

describe('nearestN', () => {
  // Entries x, y, z (stride 3).
  const pos = (pts: Array<[number, number]>): Float32Array => {
    const a = new Float32Array(pts.length * 3);
    pts.forEach(([x, z], i) => {
      a[i * 3] = x;
      a[i * 3 + 2] = z;
    });
    return a;
  };

  it('keeps the nearest N within range, nearest first', () => {
    const p = pos([
      [50, 0],
      [10, 0],
      [30, 0],
      [20, 0],
      [200, 0],
      [5, 0],
    ]);
    const out = new Int32Array(3);
    const dist = new Float64Array(3);
    const n = nearestN(p, 3, 6, 0, 0, 100, 3, out, dist);
    expect(n).toBe(3);
    expect(Array.from(out)).toEqual([5, 1, 3]);
    expect(Array.from(dist)).toEqual([25, 100, 400]);
  });

  it('drops everything beyond maxDist and handles fewer than N', () => {
    const p = pos([
      [10, 0],
      [500, 0],
    ]);
    const out = new Int32Array(4);
    const dist = new Float64Array(4);
    expect(nearestN(p, 3, 2, 0, 0, 100, 4, out, dist)).toBe(1);
    expect(out[0]).toBe(0);
    expect(nearestN(p, 3, 0, 0, 0, 100, 4, out, dist)).toBe(0);
    expect(nearestN(p, 3, 2, 0, 0, 100, 0, out, dist)).toBe(0);
  });

  it('keeps the lower index first on ties and measures from the given point', () => {
    const p = pos([
      [10, 0],
      [-10, 0],
      [0, 10],
    ]);
    const out = new Int32Array(2);
    const dist = new Float64Array(2);
    expect(nearestN(p, 3, 3, 0, 0, 50, 2, out, dist)).toBe(2);
    expect(Array.from(out)).toEqual([0, 1]);
    expect(nearestN(p, 3, 3, 0, 9, 50, 2, out, dist)).toBe(2);
    expect(out[0]).toBe(2);
  });

  it('matches a brute-force sort on random data', () => {
    const rng = createRng('vfx:nearest');
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 200; i++) pts.push([rng.nextFloat(-300, 300), rng.nextFloat(-300, 300)]);
    const p = pos(pts);
    const out = new Int32Array(32);
    const dist = new Float64Array(32);
    const n = nearestN(p, 3, pts.length, 0, 0, 140, 32, out, dist);
    const expected = pts
      .map(([x, z], i) => ({ i, d: (p[i * 3] ?? 0) ** 2 + (p[i * 3 + 2] ?? 0) ** 2, x, z }))
      .filter((e) => e.d <= 140 * 140)
      .sort((a, b) => a.d - b.d || a.i - b.i)
      .slice(0, 32);
    expect(n).toBe(expected.length);
    expect(Array.from(out.slice(0, n))).toEqual(expected.map((e) => e.i));
  });
});

describe('coneBoost', () => {
  const { fogBoost, rainBoost } = VFX_DATA.cones;

  it('is off by day and below the night threshold', () => {
    expect(coneBoost(0, 0, 0, fogBoost, rainBoost)).toBe(0);
    expect(coneBoost(0.2, 0, 0, fogBoost, rainBoost)).toBe(0);
  });

  it('scales with night and multiplies the fog and rain boosts', () => {
    expect(coneBoost(0.5, 0, 0, fogBoost, rainBoost)).toBeCloseTo(0.5, 12);
    expect(coneBoost(1, 0.005, 0, fogBoost, rainBoost)).toBe(1);
    expect(coneBoost(1, 0.02, 0, fogBoost, rainBoost)).toBeCloseTo(fogBoost, 12);
    expect(coneBoost(1, 0, 0.3, fogBoost, rainBoost)).toBeCloseTo(rainBoost, 12);
    expect(coneBoost(1, 0.02, 0.3, fogBoost, rainBoost)).toBeCloseTo(fogBoost * rainBoost, 12);
    expect(coneBoost(2, 0, 0, fogBoost, rainBoost)).toBe(1);
  });
});

describe('basisFromForward', () => {
  it('puts -Z along the direction and stays orthonormal', () => {
    const b = new Float64Array(9);
    for (const d of [
      [0, 0, -1],
      [1, 0, 0],
      [0, 0, 1],
      [0.6, -0.2, -0.77],
      [0, -1, 0],
    ] as const) {
      const len = Math.hypot(...d);
      const [dx, dy, dz] = [d[0] / len, d[1] / len, d[2] / len];
      basisFromForward(dx, dy, dz, b);
      expect(-(b[6] ?? 0)).toBeCloseTo(dx, 9);
      expect(-(b[7] ?? 0)).toBeCloseTo(dy, 9);
      expect(-(b[8] ?? 0)).toBeCloseTo(dz, 9);
      const col = (c: number): number[] => [b[c * 3] ?? 0, b[c * 3 + 1] ?? 0, b[c * 3 + 2] ?? 0];
      const dot = (a: number[], c: number[]): number => a.reduce((s, v, i) => s + v * (c[i] ?? 0), 0);
      for (let c = 0; c < 3; c++) expect(dot(col(c), col(c))).toBeCloseTo(1, 9);
      expect(dot(col(0), col(1))).toBeCloseTo(0, 9);
      expect(dot(col(0), col(2))).toBeCloseTo(0, 9);
      expect(dot(col(1), col(2))).toBeCloseTo(0, 9);
    }
  });

  it('is the identity for the default forward', () => {
    const b = new Float64Array(9);
    basisFromForward(0, 0, -1, b);
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => expect(b[i]).toBeCloseTo(v, 12));
  });
});
