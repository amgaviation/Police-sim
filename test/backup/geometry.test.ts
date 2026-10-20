import { describe, expect, it } from 'vitest';
import { BACKUP_CONFIG } from '../../src/backup/data';
import { coverSpot, poorCoverSpot, positionQuality, yawToward } from '../../src/backup/geometry';

const cfg = BACKUP_CONFIG;
const DEG = Math.PI / 180;
const out = { x: 0, z: 0, yaw: 0 };

/** Unsigned angle (degrees) at s between the directions to a and b. */
function angleAt(sx: number, sz: number, ax: number, az: number, bx: number, bz: number): number {
  const a = Math.atan2(az - sz, ax - sx);
  const b = Math.atan2(bz - sz, bx - sx);
  let d = Math.abs(a - b);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d / DEG;
}

describe('coverSpot', () => {
  it('is at the distance and angle off the contact line, on either side', () => {
    // player at the origin, subject 3 m ahead (-z)
    const px = 0, pz = 0, sx = 0, sz = -3;
    for (const side of [1, -1] as const) {
      coverSpot(px, pz, sx, sz, 52 * DEG, 5.5, side, out);
      expect(Math.hypot(out.x - sx, out.z - sz)).toBeCloseTo(5.5, 6);
      expect(angleAt(sx, sz, px, pz, out.x, out.z)).toBeCloseTo(52, 4);
    }
    coverSpot(px, pz, sx, sz, 52 * DEG, 5.5, 1, out);
    const a = { x: out.x, z: out.z };
    coverSpot(px, pz, sx, sz, 52 * DEG, 5.5, -1, out);
    expect(out.x).toBeCloseTo(-a.x, 6);
    expect(out.z).toBeCloseTo(a.z, 6);
    expect(a.x).not.toBeCloseTo(0, 3);
  });

  it('faces the subject (yaw 0 faces -z)', () => {
    coverSpot(0, 0, 0, -3, 50 * DEG, 5, 1, out);
    // facing from the spot to the subject
    const fx = -Math.sin(out.yaw);
    const fz = -Math.cos(out.yaw);
    const dx = 0 - out.x;
    const dz = -3 - out.z;
    const len = Math.hypot(dx, dz);
    expect(fx).toBeCloseTo(dx / len, 6);
    expect(fz).toBeCloseTo(dz / len, 6);
  });

  it('works when the player stands on the subject', () => {
    coverSpot(2, 2, 2, 2, 50 * DEG, 5, 1, out);
    expect(Number.isFinite(out.x) && Number.isFinite(out.z) && Number.isFinite(out.yaw)).toBe(true);
    expect(Math.hypot(out.x - 2, out.z - 2)).toBeCloseTo(5, 6);
  });
});

describe('poorCoverSpot', () => {
  it('sits on the line beyond the subject, close to it', () => {
    const px = 10, pz = 4, sx = 10, sz = 0;
    poorCoverSpot(px, pz, sx, sz, cfg, out);
    expect(Math.hypot(out.x - sx, out.z - sz)).toBeCloseTo(cfg.cover.poorDistanceM, 6);
    expect(angleAt(sx, sz, px, pz, out.x, out.z)).toBeCloseTo(cfg.cover.poorAngleDeg, 4);
    // almost straight behind the subject as seen from the player
    expect(out.z).toBeLessThan(sz);
  });
});

describe('positionQuality', () => {
  const px = 0, pz = 0, sx = 0, sz = -3;

  it('is 1 inside the ideal band', () => {
    for (const side of [1, -1] as const) {
      for (const [angle, dist] of [[45, 4.5], [52, 5.5], [60, 6.5]] as const) {
        coverSpot(px, pz, sx, sz, angle * DEG, dist, side, out);
        expect(positionQuality(px, pz, sx, sz, out.x, out.z, cfg)).toBeCloseTo(1, 6);
      }
    }
  });

  it('is 0 in the crossfire line and when too close', () => {
    poorCoverSpot(px, pz, sx, sz, cfg, out);
    expect(positionQuality(px, pz, sx, sz, out.x, out.z, cfg)).toBe(0);
    coverSpot(px, pz, sx, sz, 52 * DEG, 5.5, 1, out);
    // right behind the subject on the far side at 6 m
    expect(positionQuality(px, pz, sx, sz, sx, sz - 6, cfg)).toBe(0);
    // ideal angle but within 2 m of the subject
    coverSpot(px, pz, sx, sz, 52 * DEG, 1.5, 1, out);
    expect(positionQuality(px, pz, sx, sz, out.x, out.z, cfg)).toBe(0);
  });

  it('falls off smoothly between the ideal and the poor spot', () => {
    const q = (angle: number, dist: number): number => {
      coverSpot(px, pz, sx, sz, angle * DEG, dist, 1, out);
      return positionQuality(px, pz, sx, sz, out.x, out.z, cfg);
    };
    expect(q(90, 5.5)).toBeGreaterThan(0.3);
    expect(q(90, 5.5)).toBeLessThan(0.9);
    expect(q(120, 5.5)).toBeLessThan(q(90, 5.5));
    expect(q(52, 3.5)).toBeGreaterThan(0);
    expect(q(52, 3.5)).toBeLessThan(1);
    expect(q(52, 12)).toBeLessThan(q(52, 8));
    expect(q(20, 5.5)).toBeLessThan(1);
    for (let a = 0; a <= 180; a += 10) for (let d = 0; d <= 15; d += 1.5) {
      const v = q(a, d);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('yawToward', () => {
  it('uses the -z convention', () => {
    expect(yawToward(0, 0, 0, -5)).toBeCloseTo(0, 9);
    expect(yawToward(0, 0, -5, 0)).toBeCloseTo(Math.PI / 2, 9);
    expect(Math.abs(yawToward(0, 0, 0, 5))).toBeCloseTo(Math.PI, 9);
    expect(yawToward(1, 1, 1, 1)).toBe(0);
  });
});
