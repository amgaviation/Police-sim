import { describe, expect, it } from 'vitest';
import { IDM_S0, idmAccel } from '../../src/traffic/idm';

const DT = 1 / 60;

describe('idmAccel', () => {
  it('accelerates at aMax from rest on a free road and settles at v0', () => {
    expect(idmAccel(0, 15, Infinity, 0, 2, 2.5, 1.4)).toBeCloseTo(2, 10);
    expect(idmAccel(15, 15, Infinity, 0, 2, 2.5, 1.4)).toBeCloseTo(0, 10);
    expect(idmAccel(20, 15, Infinity, 0, 2, 2.5, 1.4)).toBeLessThan(0);
    let v = 0;
    for (let i = 0; i < 60 * 60; i++) v += idmAccel(v, 15, Infinity, 0, 2, 2.5, 1.4) * DT;
    expect(v).toBeGreaterThan(14.5);
    expect(v).toBeLessThanOrEqual(15);
  });

  it('stops behind a stopped leader with a gap of at least s0', () => {
    let v = 15;
    let gap = 120;
    let minGap = Infinity;
    for (let i = 0; i < 60 * 60; i++) {
      const a = Math.max(-7, idmAccel(v, 15, gap, v, 2, 2.5, 1.4));
      v = Math.max(0, v + a * DT);
      gap -= v * DT;
      minGap = Math.min(minGap, gap);
    }
    expect(v).toBeLessThan(0.05);
    expect(minGap).toBeGreaterThanOrEqual(IDM_S0);
    expect(gap).toBeLessThan(IDM_S0 + 1);
  });

  it('follows a slower leader without closing below the safe headway', () => {
    let v = 20;
    let gap = 60;
    const vl = 10;
    for (let i = 0; i < 60 * 120; i++) {
      const a = Math.max(-7, idmAccel(v, 20, gap, v - vl, 2, 2.5, 1.4));
      v = Math.max(0, v + a * DT);
      gap += (vl - v) * DT;
    }
    expect(v).toBeCloseTo(vl, 1);
    expect(gap).toBeGreaterThan(IDM_S0 + vl * 1.4);
  });
});
