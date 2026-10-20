import { describe, expect, it } from 'vitest';
import { BODY } from '../../src/render/people/pose';
import { at, eventsOf, makeCall, makeHarness, pointFromStation, run, runUntil, step, view } from './helpers';

describe('EMS transport', () => {
  it('removes the patient, goes transporting to the hospital, then is available again', () => {
    const h = makeHarness();
    const to = pointFromStation(h, 900);
    const c = makeCall(h, 1, to.x, to.z);
    h.npc.add(11, 700, to.x + 5, to.z, { callId: c.id });
    h.res.request({ kind: 'request', typeId: 'ems', callId: c.id, via: 'radio' });
    expect(runUntil(h, () => view(h, 'MEDIC-1').status === 'onScene', 600)).toBe(true);
    // Only an on-scene EMS unit can transport.
    expect(h.res.transport('MEDIC-2', 700)).toBe(false);
    expect(h.res.transport('K9-1', 700)).toBe(false);
    expect(h.res.transport('nobody', 700)).toBe(false);
    expect(h.res.transport('MEDIC-1', 700)).toBe(true);
    expect(h.npc.removed).toEqual([11]);
    expect(h.custody).toEqual([[700, 'hospital']]);
    step(h);
    expect(view(h, 'MEDIC-1').status).toBe('transporting');
    expect(h.cad.unit('MEDIC-1')?.status).toBe('transporting');
    expect(h.cad.unit('MEDIC-1')?.callId).toBe(c.id);
    expect(h.res.onScene(c.id, 'ems')).toBe(0);
    expect(eventsOf(h, 'resource:cleared')).toHaveLength(1);
    // Transporting again is refused.
    expect(h.res.transport('MEDIC-1', 701)).toBe(false);
    const hospital = h.city.pois.find((p) => p.kind === 'hospital');
    expect(hospital).toBeDefined();
    const idx = [...h.traffic.cars.keys()][0] ?? -1;
    const car = h.traffic.cars.get(idx);
    expect(car?.dx).toBeCloseTo(hospital?.entrance.x ?? 0, 3);
    expect(car?.dz).toBeCloseTo(hospital?.entrance.z ?? 0, 3);
    expect(runUntil(h, () => view(h, 'MEDIC-1').status === 'available', 900)).toBe(true);
    expect(h.cad.unit('MEDIC-1')?.status).toBe('available');
    expect(h.cad.unit('MEDIC-1')?.callId).toBeNull();
    expect(h.traffic.cars.size).toBe(0);
    // The ambulance can respond again.
    const c2 = makeCall(h, 2, to.x, to.z - 300);
    h.res.request({ kind: 'request', typeId: 'ems', callId: c2.id, via: 'radio' });
    step(h);
    expect(eventsOf<{ callsign: string }>(h, 'resource:dispatched').map((e) => e.callsign)).toEqual(['MEDIC-1', 'MEDIC-1']);
  });

  it('a call that closes while the ambulance transports does not stop the trip', () => {
    const h = makeHarness();
    const to = pointFromStation(h, 700);
    const c = makeCall(h, 1, to.x, to.z);
    h.res.request({ kind: 'request', typeId: 'ems', callId: c.id, via: 'radio' });
    expect(runUntil(h, () => view(h, 'MEDIC-1').status === 'onScene', 600)).toBe(true);
    expect(h.res.transport('MEDIC-1', 5)).toBe(true);
    run(h, 1);
    h.cad.closeCall(c.id, 'handled', at(h.sim));
    step(h);
    expect(view(h, 'MEDIC-1').status).toBe('transporting');
    expect(runUntil(h, () => view(h, 'MEDIC-1').status === 'available', 900)).toBe(true);
  });
});

describe('crews', () => {
  it('shows the K9 handler and dog beside the car, then removes them when the unit leaves', () => {
    const h = makeHarness();
    const to = pointFromStation(h, 700);
    const c = makeCall(h, 2, to.x, to.z);
    h.res.request({ kind: 'request', typeId: 'k9', callId: c.id, via: 'radio' });
    expect(h.res.crews.count).toBe(0);
    expect(runUntil(h, () => view(h, 'K9-1').status === 'onScene', 600)).toBe(true);
    run(h, 0.5);
    const crews = h.res.crews;
    expect(crews.count).toBe(2);
    const car = [...h.traffic.cars.values()][0];
    expect(car).toBeDefined();
    for (let i = 0; i < crews.count; i++) {
      const d = Math.hypot((crews.x[i] ?? 0) - (car?.x ?? 0), (crews.z[i] ?? 0) - (car?.z ?? 0));
      expect(d).toBeGreaterThan(1.5);
      expect(d).toBeLessThan(4.5);
      expect(crews.y[i]).toBe(0);
    }
    expect(crews.body[0]).toBe(BODY.human);
    expect(crews.body[1]).toBe(BODY.dog);
    expect(crews.height[1]).toBeCloseTo(0.6, 5);
    expect(crews.top[0]).toBe(0x1f2b3c);
    expect(runUntil(h, () => view(h, 'K9-1').status === 'returning', 700)).toBe(true);
    run(h, 0.3);
    expect(h.res.crews.count).toBe(0);
  });

  it('an ambulance shows two figures and the supervisor one, and no more than 48 are ever written', () => {
    const h = makeHarness();
    const to = pointFromStation(h, 500);
    const c = makeCall(h, 1, to.x, to.z);
    for (const typeId of ['ems', 'fire', 'supervisor', 'csu', 'detectives']) h.res.request({ kind: 'request', typeId, callId: c.id, via: 'mdt' });
    expect(runUntil(h, () => ['MEDIC-1', 'ENGINE-1', 'SGT-1', 'CSU-1', 'DET-1'].every((cs) => view(h, cs).status === 'onScene'), 1500)).toBe(true);
    run(h, 0.5);
    // 2 + 3 + 1 + 2 + 2
    expect(h.res.crews.count).toBe(10);
    expect(h.res.crews.x.length).toBe(48);
  });
});

describe('directTo and unitPose', () => {
  it('state units start at the highway end nearer to the call and can be sent elsewhere', () => {
    const h = makeHarness();
    const east = pointFromStation(h, 1500);
    const c = makeCall(h, 1, east.x, east.z);
    h.res.request({ kind: 'request', typeId: 'statePatrol', callId: c.id, via: 'radio' });
    expect(runUntil(h, () => h.traffic.spawns.length > 0, 120)).toBe(true);
    expect(Math.abs(h.traffic.spawns[0]?.x ?? 0)).toBeGreaterThan(3000);
    step(h);
    const pose = { x: 0, z: 0, yaw: 0, speed: 0 };
    expect(h.res.unitPose('STATE-1', pose)).toBe(true);
    expect(pose.speed).toBeGreaterThan(0);
    expect(h.res.unitPose('STATE-2', pose)).toBe(false);
    expect(h.res.unitPose('AIR-1', pose)).toBe(false);
    expect(h.res.unitPose('nobody', pose)).toBe(false);

    // Not assigned / unknown / air units cannot be directed.
    expect(h.res.directTo('STATE-2', 0, 0, 'respond')).toBe(false);
    expect(h.res.directTo('nobody', 0, 0, 'respond')).toBe(false);
    expect(h.res.directTo('AIR-1', 0, 0, 'respond')).toBe(false);
    const target = { x: east.x - 400, z: east.z + 200 };
    expect(h.res.directTo('STATE-1', target.x, target.z, 'emergency')).toBe(true);
    const car = [...h.traffic.cars.values()][0];
    expect(car?.dx).toBeCloseTo(target.x, 3);
    expect(car?.urgency).toBe('emergency');
    expect(runUntil(h, () => view(h, 'STATE-1').status === 'onScene', 400)).toBe(true);
    // Directed from the scene: the unit goes en route again and arrives at the new point.
    const far = { x: target.x + 600, z: target.z };
    expect(h.res.directTo('STATE-1', far.x, far.z, 'respond')).toBe(true);
    step(h);
    expect(view(h, 'STATE-1').status).toBe('enRoute');
    expect(h.cad.unit('STATE-1')?.status).toBe('enRoute');
    expect(runUntil(h, () => view(h, 'STATE-1').status === 'onScene', 400)).toBe(true);
    // Re-pointing within 30 m of where it stands does not move it.
    expect(h.res.directTo('STATE-1', far.x + 5, far.z + 5, 'respond')).toBe(true);
    expect(view(h, 'STATE-1').status).toBe('onScene');
  });

  it('federal units start at the world edge', () => {
    const h = makeHarness();
    const to = pointFromStation(h, 1000);
    const c = makeCall(h, 3, to.x, to.z);
    h.res.request({ kind: 'request', typeId: 'federal', callId: c.id, via: 'mdt' });
    expect(runUntil(h, () => h.traffic.spawns.length > 0, 1400)).toBe(true);
    const s = h.traffic.spawns[0];
    expect(Math.max(Math.abs(s?.x ?? 0), Math.abs(s?.z ?? 0))).toBeGreaterThan(2500);
  });
});
