import { describe, expect, it } from 'vitest';
import { ON_STATION_S, ON_TARGET_M, ORBIT_R, airOnTarget, compassWord, newAirState, stepAir } from '../../src/resources/air';
import { EDGE_COORD, basePoint, firstPoiPoint, nearestPoiPoint, stationPoint } from '../../src/resources/bases';
import { CREW_SIDE_M, CREW_SPACING_M, crewSpot } from '../../src/resources/crews';
import { cityFor } from '../world/helpers';

const DT = 1 / 60;

describe('stepAir', () => {
  it('flies straight at the cruise speed and stops at a non-orbit goal', () => {
    const s = newAirState(0, 0);
    for (let i = 0; i < 60; i++) stepAir(s, DT, 1000, 0, false, 150, 45);
    expect(Math.hypot(s.x, s.z)).toBeCloseTo(45, 1);
    for (let i = 0; i < 60 * 40; i++) stepAir(s, DT, 1000, 0, false, 150, 45);
    expect(s.x).toBeCloseTo(1000, 3);
    expect(s.z).toBeCloseTo(0, 3);
  });

  it('climbs and descends at 8 m/s', () => {
    const s = newAirState(0, 0);
    for (let i = 0; i < 60; i++) stepAir(s, DT, 0, 0, false, 150, 45);
    expect(s.y).toBeCloseTo(8, 1);
    s.y = 100;
    for (let i = 0; i < 60; i++) stepAir(s, DT, 0, 0, false, 0, 45);
    expect(s.y).toBeCloseTo(92, 1);
    for (let i = 0; i < 60 * 20; i++) stepAir(s, DT, 0, 0, false, 0, 45);
    expect(s.y).toBe(0);
  });

  it('orbits at the orbit radius once close, covering the angle at speed * 0.5 / radius', () => {
    const s = newAirState(1000, 0);
    for (let i = 0; i < 60 * 40; i++) stepAir(s, DT, 0, 0, true, 150, 45);
    const r = Math.hypot(s.x, s.z);
    expect(r).toBeGreaterThan(ORBIT_R - 1);
    expect(r).toBeLessThan(ORBIT_R + 2);
    const a0 = Math.atan2(s.z, s.x);
    for (let i = 0; i < 60; i++) stepAir(s, DT, 0, 0, true, 150, 45);
    let da = Math.atan2(s.z, s.x) - a0;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    expect(da).toBeCloseTo((45 * 0.5) / ORBIT_R, 2);
    // Still within the on-target radius, and a far point is not.
    expect(airOnTarget(s, 0, 0)).toBe(true);
    expect(airOnTarget(s, ON_TARGET_M + ORBIT_R + 10, 0)).toBe(false);
  });

  it('turns no faster than 0.6 rad/s', () => {
    const s = newAirState(0, 0);
    s.yaw = 0;
    // Goal to the east (+x): the desired yaw is -pi/2.
    for (let i = 0; i < 60; i++) stepAir(s, DT, 1000, 0, false, 0, 45);
    expect(Math.abs(s.yaw)).toBeLessThanOrEqual(0.6 + 1e-6);
  });

  it('keeps the on-station time constant at 900 s', () => {
    expect(ON_STATION_S).toBe(900);
  });
});

describe('compassWord', () => {
  it('names the eight directions (north is -z)', () => {
    expect(compassWord(0, 0, 0, -10)).toBe('north');
    expect(compassWord(0, 0, 10, 0)).toBe('east');
    expect(compassWord(0, 0, 0, 10)).toBe('south');
    expect(compassWord(0, 0, -10, 0)).toBe('west');
    expect(compassWord(0, 0, 10, -10)).toBe('northeast');
    expect(compassWord(0, 0, -10, 10)).toBe('southwest');
  });
});

describe('crewSpot', () => {
  it('stands 2.2 m to the right of the rear axle, spaced 0.9 m, facing away', () => {
    const out = { x: 0, z: 0, yaw: 0 };
    // Vehicle at the origin facing -z (yaw 0): its right is +x; the rear is +z.
    crewSpot(0, 0, 0, 0, 1, out);
    expect(out.x).toBeCloseTo(CREW_SIDE_M, 6);
    expect(out.z).toBeGreaterThan(0);
    const a = { x: 0, z: 0, yaw: 0 };
    const b = { x: 0, z: 0, yaw: 0 };
    crewSpot(0, 0, 0, 0, 2, a);
    crewSpot(0, 0, 0, 1, 2, b);
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(Math.abs(a.z - b.z)).toBeCloseTo(CREW_SPACING_M, 6);
    // Facing away from the vehicle: +x is yaw -pi/2.
    expect(out.yaw).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('rotates with the vehicle', () => {
    const out = { x: 0, z: 0, yaw: 0 };
    // Facing +x (yaw -pi/2): the right side is +z.
    crewSpot(10, 20, -Math.PI / 2, 0, 1, out);
    expect(out.z - 20).toBeCloseTo(CREW_SIDE_M, 6);
  });
});

describe('bases', () => {
  const city = cityFor(42);
  const p = { x: 0, z: 0 };

  it('station, hospital, airport and harbor are POI entrances', () => {
    const st = city.pois.find((q) => q.kind === 'station');
    expect(st).toBeDefined();
    expect(stationPoint(city, p)).toEqual({ x: st?.entrance.x, z: st?.entrance.z });
    for (const kind of ['hospital', 'airport', 'harbor'] as const) {
      const poi = city.pois.find((q) => q.kind === kind);
      const got = basePoint(city, kind, 0, 0, { x: 0, z: 0 });
      expect(got).toEqual(firstPoiPoint(city, kind, { x: 0, z: 0 }));
      if (poi) expect(got).toEqual({ x: poi.entrance.x, z: poi.entrance.z });
    }
    expect(nearestPoiPoint(city, 'hospital', 0, 0, { x: 0, z: 0 })).toBeDefined();
  });

  it('highway is the end of the state highway nearer to the call', () => {
    const east = basePoint(city, 'highway', 1000, 0, { x: 0, z: 0 });
    const west = basePoint(city, 'highway', -1000, 0, { x: 0, z: 0 });
    expect(east.x).toBe(3584);
    expect(west.x).toBe(-3584);
    expect(east.z).toBe(west.z);
  });

  it('edge is a road point near the world edge, nearest to the call', () => {
    const east = basePoint(city, 'edge', 3000, 100, { x: 0, z: 0 });
    expect(east.x).toBeGreaterThan(EDGE_COORD - 700);
    const north = basePoint(city, 'edge', 100, -3100, { x: 0, z: 0 });
    expect(north.z).toBeLessThan(-EDGE_COORD + 700);
    // The point is on a road (the graph snaps it).
    const hit = city.graph.nearestEdge(east.x, east.z, 5, { edge: -1, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 });
    expect(hit).not.toBeNull();
  });
});
