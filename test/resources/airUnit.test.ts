import { describe, expect, it } from 'vitest';
import { ON_STATION_S, ON_TARGET_M, ORBIT_R } from '../../src/resources/air';
import { basePoint } from '../../src/resources/bases';
import { UNIT_TYPES } from '../../src/units';
import { at, eventsOf, makeCall, makeHarness, pointFromStation, run, runUntil, step, view, type Harness } from './helpers';

const SPEED = UNIT_TYPES.airSpeedMps;

interface AirOut {
  x: number;
  z: number;
  y: number;
  onTarget: boolean;
  spot: boolean;
}

function airOut(h: Harness): AirOut | null {
  const out: AirOut = { x: 0, z: 0, y: 0, onTarget: false, spot: false };
  return h.res.air(out) ? out : null;
}

function setup(night = false) {
  const h = makeHarness({ night });
  const to = pointFromStation(h, 2200);
  const c = makeCall(h, 1, to.x, to.z);
  const pad = basePoint(h.city, 'airport', to.x, to.z, { x: 0, z: 0 });
  return { h, to, c, pad };
}

describe('air unit', () => {
  it('waits at the base for its turnout, then flies at the cruise speed toward the call', () => {
    const { h, to, c, pad } = setup();
    h.res.request({ kind: 'request', typeId: 'air', callId: c.id, via: 'radio' });
    step(h);
    const d = eventsOf<{ callsign: string; etaS: number }>(h, 'resource:dispatched')[0];
    expect(d?.callsign).toBe('AIR-1');
    // airEta: straight line / speed + turnout (P1 = 60 s).
    const dist = Math.hypot(to.x - pad.x, to.z - pad.z);
    expect(d?.etaS).toBeCloseTo(dist / SPEED + 60, 6);
    expect(h.cad.unit('AIR-1')?.status).toBe('enRoute');
    expect(h.res.airView()).toBeNull();
    expect(airOut(h)).toBeNull();
    run(h, 55);
    expect(h.res.airView()).toBeNull();
    // Take-off.
    expect(runUntil(h, () => airOut(h) !== null, 10)).toBe(true);
    const t0 = h.sim;
    run(h, 10);
    const a = airOut(h);
    expect(a).not.toBeNull();
    if (!a) return;
    const flown = Math.hypot(a.x - pad.x, a.z - pad.z);
    expect(flown).toBeGreaterThan(SPEED * 9.5);
    expect(flown).toBeLessThan(SPEED * (h.sim - t0 + 1));
    // It climbs at 8 m/s and cruises at the data altitude.
    expect(a.y).toBeGreaterThan(70);
    expect(a.y).toBeLessThanOrEqual(UNIT_TYPES.airAltitudeM);
    expect(h.res.eta('AIR-1')).toBeLessThan((d?.etaS ?? 0) - 60);
    // The view mirrors it.
    const v = h.res.airView();
    expect(v?.x).toBeCloseTo(a.x, 6);
    expect(v?.y).toBeCloseTo(a.y, 6);
  });

  it('arrives within 200 m, orbits the call at 120 m, switches the spotlight on at night and is on target', () => {
    const { h, to, c } = setup(true);
    h.res.request({ kind: 'request', typeId: 'air', callId: c.id, via: 'radio' });
    expect(runUntil(h, () => view(h, 'AIR-1').status === 'onScene', 300)).toBe(true);
    expect(h.cad.unit('AIR-1')?.status).toBe('onScene');
    expect(eventsOf(h, 'resource:arrived')).toHaveLength(1);
    run(h, 20);
    const a = airOut(h);
    expect(a?.onTarget).toBe(true);
    expect(a?.spot).toBe(true);
    const r = Math.hypot((a?.x ?? 0) - to.x, (a?.z ?? 0) - to.z);
    expect(r).toBeGreaterThan(ORBIT_R - 3);
    expect(r).toBeLessThan(ORBIT_R + 3);
    const v = h.res.airView();
    expect(v?.spot).toBe(true);
    expect(v?.onTarget).toBe(true);
    expect(v?.targetX).toBeCloseTo(to.x, 6);
    expect(v?.rotor).toBeGreaterThanOrEqual(0);
    // During the day there is no spotlight.
    h.env.night = false;
    step(h);
    expect(airOut(h)?.spot).toBe(false);
    expect(ON_TARGET_M).toBe(200);
  });

  it('follows a vehicle, an actor and a point target, and goes back to the call with none', () => {
    const { h, to, c } = setup();
    h.res.request({ kind: 'request', typeId: 'air', callId: c.id, via: 'radio' });
    expect(runUntil(h, () => view(h, 'AIR-1').status === 'onScene', 300)).toBe(true);
    const far = { x: to.x + 900, z: to.z + 100 };
    h.traffic.flees.set(77, { x: far.x, z: far.z, yaw: 0, speed: 30, edge: 0 });
    h.res.setAirTarget('vehicle', 77, 0, 0);
    expect(runUntil(h, () => Math.hypot((airOut(h)?.x ?? 0) - far.x, (airOut(h)?.z ?? 0) - far.z) < ORBIT_R + 5, 60)).toBe(true);
    run(h, 10);
    expect(airOut(h)?.onTarget).toBe(true);
    // The flee ends: the last known point is kept.
    h.traffic.flees.delete(77);
    run(h, 2);
    expect(h.res.airView()?.targetX).toBeCloseTo(far.x, 3);
    // An actor.
    h.npc.add(5, 500, to.x - 700, to.z, {});
    h.res.setAirTarget('actor', 5, 0, 0);
    expect(runUntil(h, () => h.res.airView()?.targetX === to.x - 700, 5)).toBe(true);
    // A point.
    h.res.setAirTarget('point', 0, to.x, to.z - 500);
    run(h, 1);
    expect(h.res.airView()?.targetZ).toBeCloseTo(to.z - 500, 3);
    h.res.setAirTarget('none', 0, 0, 0);
    run(h, 1);
    expect(h.res.airView()?.targetX).toBeCloseTo(to.x, 3);
    expect(h.res.airView()?.targetZ).toBeCloseTo(to.z, 3);
  });

  it('reveals hidden outdoor actors within 80 m of the target exactly once', () => {
    const { h, to, c } = setup();
    h.npc.add(1, 101, to.x + 30, to.z + 10, { hidden: true });
    h.npc.add(2, 102, to.x + 40, to.z, { hidden: true, building: 3 });
    h.npc.add(3, 103, to.x + 200, to.z, { hidden: true });
    h.npc.add(4, 104, to.x, to.z - 20, { hidden: false });
    h.res.request({ kind: 'request', typeId: 'air', callId: c.id, via: 'radio' });
    expect(runUntil(h, () => h.npc.revealed.length > 0, 300)).toBe(true);
    run(h, 10);
    expect(h.npc.revealed).toEqual([1]);
    const line = h.radio.find((r) => r.text.includes('heat signature'));
    expect(line?.speaker).toBe('AIR-1');
    expect(line?.text).toMatch(/^AIR-1, I have a heat signature (north|south|east|west|northeast|northwest|southeast|southwest) of the Main Street at 1st Street\.$/);
    // A new hidden actor appearing later is revealed; the first is not revealed again.
    h.npc.add(6, 106, to.x - 20, to.z + 20, { hidden: true });
    run(h, 2);
    expect(h.npc.revealed).toEqual([1, 6]);
    // A revealed actor that hides again is not announced twice.
    const a1 = h.npc.actors.get(1);
    if (a1) a1.hidden = true;
    run(h, 2);
    expect(h.npc.revealed).toEqual([1, 6]);
    expect(h.res.serialize().air?.revealed).toEqual([1, 6]);
  });

  it('stays 900 s on station, flies back and lands at the airport', () => {
    const { h, c, pad } = setup();
    h.res.request({ kind: 'request', typeId: 'air', callId: c.id, via: 'radio' });
    expect(runUntil(h, () => view(h, 'AIR-1').status === 'onScene', 300)).toBe(true);
    const arrived = h.sim;
    expect(h.res.serialize().air?.onStationUntil).toBeCloseTo(arrived + ON_STATION_S, 0);
    run(h, ON_STATION_S - 30);
    expect(view(h, 'AIR-1').status).toBe('onScene');
    expect(runUntil(h, () => view(h, 'AIR-1').status === 'returning', 60)).toBe(true);
    expect(h.cad.unit('AIR-1')?.status).toBe('available');
    expect(h.cad.unit('AIR-1')?.callId).toBeNull();
    expect(h.res.airView()).not.toBeNull();
    expect(runUntil(h, () => view(h, 'AIR-1').status === 'available', 200)).toBe(true);
    expect(h.res.airView()).toBeNull();
    expect(airOut(h)).toBeNull();
    const cu = h.cad.unit('AIR-1');
    expect(Math.hypot((cu?.x ?? 0) - pad.x, (cu?.z ?? 0) - pad.z)).toBeLessThan(1);
    // Ready for the next request.
    const c2 = makeCall(h, 2, pad.x + 500, pad.z);
    h.res.request({ kind: 'request', typeId: 'air', callId: c2.id, via: 'radio' });
    step(h);
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(2);
    expect(at(0).sim).toBe(0);
  });

  it('goes home early when the call closes', () => {
    const { h, c } = setup();
    h.res.request({ kind: 'request', typeId: 'air', callId: c.id, via: 'radio' });
    expect(runUntil(h, () => view(h, 'AIR-1').status === 'onScene', 300)).toBe(true);
    h.cad.closeCall(c.id, 'handled', at(h.sim));
    step(h);
    expect(view(h, 'AIR-1').status).toBe('returning');
    expect(runUntil(h, () => view(h, 'AIR-1').status === 'available', 200)).toBe(true);
  });

  it('is requested once per call, and a second air request while it is busy reports no unit', () => {
    const { h, c } = setup();
    h.res.request({ kind: 'request', typeId: 'air', callId: c.id, via: 'radio' });
    const c2 = makeCall(h, 2, c.location.x + 100, c.location.z);
    h.res.request({ kind: 'request', typeId: 'air', callId: c2.id, via: 'radio' });
    step(h);
    expect(eventsOf(h, 'resource:dispatched')).toHaveLength(1);
    expect(h.radio.some((r) => r.text === 'No Air unit available.' || /No .* available\./.test(r.text))).toBe(true);
  });
});
