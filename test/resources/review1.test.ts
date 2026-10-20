import { describe, expect, it } from 'vitest';
import { at, makeCall, makeHarness, pointFromStation, run, runUntil, step, view } from './helpers';

function force(h: ReturnType<typeof makeHarness>, callId: number): void {
  h.bus.emit('force:applied', {
    seq: 1, tool: 'firearm', level: 'firearm', personId: 1, actorId: 1, callId, resistance: 'active', hit: true, injury: 0, fatal: false, cycle: 1,
    riskFactors: [], distance: 2, restrained: false, sim: h.sim,
  });
}

/** A sergeant on scene of a call. */
function sergeantOnScene(): { h: ReturnType<typeof makeHarness>; callId: number } {
  const h = makeHarness();
  const to = pointFromStation(h, 600);
  const c = makeCall(h, 2, to.x, to.z);
  force(h, c.id);
  expect(runUntil(h, () => view(h, 'SGT-1').status === 'onScene', 400)).toBe(true);
  return { h, callId: c.id };
}

describe('units with an officer on foot', () => {
  it('stay when the call closes until the officer is back in the car', () => {
    const { h, callId } = sergeantOnScene();
    h.onFoot.add('SGT-1');
    h.cad.closeCall(callId, 'handled', at(h.sim));
    run(h, 5);
    expect(view(h, 'SGT-1').status).toBe('onScene');
    expect(h.res.leaving('SGT-1')).toBe(true);
    h.onFoot.delete('SGT-1');
    run(h, 1);
    expect(view(h, 'SGT-1').status).toBe('returning');
    expect(h.res.leaving('SGT-1')).toBe(false);
  });

  it('wait at most 30 s for an officer that never gets back', () => {
    const { h, callId } = sergeantOnScene();
    h.onFoot.add('SGT-1');
    h.cad.closeCall(callId, 'handled', at(h.sim));
    run(h, 27);
    expect(view(h, 'SGT-1').status).toBe('onScene');
    run(h, 6);
    expect(view(h, 'SGT-1').status).toBe('returning');
  });

  it('a timed unit (state patrol) waits when its time is up', () => {
    const h = makeHarness();
    const to = pointFromStation(h, 600);
    const c = makeCall(h, 3, to.x, to.z);
    h.res.request({ kind: 'request', typeId: 'statePatrol', callId: c.id, via: 'mdt' });
    expect(runUntil(h, () => view(h, 'STATE-1').status === 'onScene', 400)).toBe(true);
    h.onFoot.add('STATE-1');
    expect(h.res.leaving('STATE-1')).toBe(false);
    expect(runUntil(h, () => h.res.leaving('STATE-1'), 620)).toBe(true);
    run(h, 10);
    expect(view(h, 'STATE-1').status).toBe('onScene');
    h.onFoot.delete('STATE-1');
    run(h, 1);
    expect(view(h, 'STATE-1').status).toBe('returning');
  });

  it('do not draw the static crew figure (the walking officer replaces it)', () => {
    const { h } = sergeantOnScene();
    run(h, 1);
    const before = h.res.crews.count;
    expect(before).toBeGreaterThan(0);
    h.onFoot.add('SGT-1');
    run(h, 1);
    expect(h.res.crews.count).toBe(before - 1);
    h.onFoot.delete('SGT-1');
    run(h, 1);
    expect(h.res.crews.count).toBe(before);
  });
});

describe('requests with a scene', () => {
  it('"EMS 3" asks the scene once and assigns three ambulances itself', () => {
    const h = makeHarness({ scenario: true });
    const to = pointFromStation(h, 600);
    const c = makeCall(h, 2, to.x, to.z);
    for (let i = 0; i < 3; i++) h.res.request({ kind: 'request', typeId: 'ems', callId: c.id, via: 'mdt' });
    step(h);
    expect(h.sceneRequests.filter((r) => r.kind === 'serviceRequest')).toHaveLength(1);
    const ems = h.res.units().filter((u) => u.callsign.startsWith('MEDIC') && u.callId === c.id);
    expect(ems).toHaveLength(3);
    // The scene's own answer (provide) is a no-op once units are assigned.
    expect(h.res.provide(c.id, 'ems')).toBe(true);
    step(h);
    expect(h.res.units().filter((u) => u.callsign.startsWith('MEDIC') && u.callId === c.id)).toHaveLength(3);
  });

  it('a single request still goes through the scene only', () => {
    const h = makeHarness({ scenario: true });
    const to = pointFromStation(h, 600);
    const c = makeCall(h, 2, to.x, to.z);
    h.res.request({ kind: 'request', typeId: 'ems', callId: c.id, via: 'radio' });
    step(h);
    expect(h.sceneRequests.filter((r) => r.kind === 'serviceRequest')).toHaveLength(1);
    expect(h.res.units().filter((u) => u.callsign.startsWith('MEDIC') && u.callId === c.id)).toHaveLength(0);
  });
});

describe('HUD ETA', () => {
  it('counts the patrol units sent as backup, soonest first', () => {
    const h = makeHarness();
    const to = pointFromStation(h, 600);
    const c = makeCall(h, 2, to.x, to.z);
    h.cad.setUnitStatus('12', 'onScene', at(h.sim), 'auto');
    for (const [i, cs] of ['21', '23'].entries()) {
      h.cad.addUnit({ callsign: cs, kind: 'ai', officer: `Officer ${cs}`, beat: 'downtown', fleetIndex: i }, at(h.sim));
      h.traffic.spawnFleetCar(i, to.x + 400 + i * 400, to.z);
      h.cad.assign(c.id, cs, at(h.sim), 'backup');
      h.cad.setUnitStatus(cs, 'enRoute', at(h.sim), 'auto');
      h.traffic.setFleetDestination(i, to.x, to.z, 'emergency');
    }
    run(h, 2);
    expect(h.res.hud().next).toMatch(/^21 ETA \d+:\d\d$/);
    expect(h.res.eta('21')).toBeGreaterThan(0);
    expect(h.res.eta('21')).toBeLessThan(h.res.eta('23'));
  });
});
