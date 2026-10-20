import { describe, expect, it } from 'vitest';
import type { PursuitOrderEvent } from '../../src/incidents/events';
import { isIncidentsSave } from '../../src/incidents/save';
import { callInfo, key, Rig } from './helpers';

const K = key(7);

function order(over: Partial<PursuitOrderEvent> = {}): PursuitOrderEvent {
  return { callId: 20, order: 'terminate', by: 'SGT-1', text: 'Sergeant SGT-1: terminate the pursuit.', sim: 0, ...over };
}

/** A running vehicle pursuit within policy (30 mph in a 35 zone) on call 7, sampler on pursuit call 20. */
function pursuitRig(speed = 30): Rig {
  const rig = new Rig();
  rig.world.calls.set(7, callInfo());
  rig.world.roles.set(5, 'suspect');
  rig.bus.emit('scene:materialized', { callId: 7 });
  rig.step();
  rig.world.stop = { personId: 5, vehicleId: 3, callId: 7 };
  rig.world.pursuit = { speedMph: speed, limitMph: 35, district: 'downtown', wet: false, night: false, lights: true, siren: true };
  rig.bus.emit('dispatch:plateResult', {
    callsign: 'A-12', via: 'radio', vehicleId: 3,
    readback: { plate: 'X', found: true, description: '', owner: '', ownerPersonId: -1, hits: ['STOLEN VEHICLE'], severity: 'alert' },
  });
  rig.bus.emit('scene:pursuit', { kind: 'vehicle', active: true, callId: 20, ownerCallId: 7, personId: 5 });
  return rig;
}

const terminateAdvisories = (rig: Rig) => rig.of(K, 'advisory').filter((a) => a.advisory === 'terminatePursuit');

describe('pursuit:order terminate (Phase 6)', () => {
  it('records one terminatePursuit advisory with the order text, without incident:advisory', () => {
    const rig = pursuitRig();
    rig.seconds(3);
    expect(terminateAdvisories(rig)).toHaveLength(0);
    rig.bus.emit('pursuit:order', order());
    expect(terminateAdvisories(rig)).toHaveLength(1);
    expect(terminateAdvisories(rig)[0]).toMatchObject({ personId: 5, text: 'Sergeant SGT-1: terminate the pursuit.' });
    expect(rig.advisories).toEqual([]);
    // Once per pursuit.
    rig.bus.emit('pursuit:order', order({ text: 'again' }));
    expect(terminateAdvisories(rig)).toHaveLength(1);
  });

  it('suppresses the recorder\'s own termination advisory afterwards (the order set `advised`)', () => {
    const rig = pursuitRig(80);
    rig.bus.emit('pursuit:order', order());
    rig.seconds(40);
    expect(terminateAdvisories(rig)).toHaveLength(1);
    expect(rig.advisories).toEqual([]);
  });

  it('does not stop the recorder\'s own advisory when it comes first (no duplicate from the order)', () => {
    const rig = pursuitRig(80);
    rig.seconds(40);
    expect(rig.advisories).toHaveLength(1);
    rig.bus.emit('pursuit:order', order());
    expect(terminateAdvisories(rig)).toHaveLength(1);
  });

  it('evaluatePursuit counts the ignored advisory time from the order', () => {
    const rig = pursuitRig();
    rig.seconds(3);
    rig.bus.emit('pursuit:order', order());
    rig.seconds(30);
    rig.bus.emit('scene:pursuit', { kind: 'vehicle', active: false, callId: 20, ownerCallId: 7, personId: 5, endReason: 'escaped' });
    const ruling = rig.sys.assessment(K)?.pursuits[0];
    expect(ruling?.advisoryIgnoredS).toBeGreaterThan(25);
    expect(ruling?.outcome).toBe('unlawful');
    expect(ruling?.reasons.some((r) => r.startsWith('Termination advisory ignored'))).toBe(true);
  });

  it('ignores other orders, other pursuit calls and orders without a running sampler', () => {
    const rig = pursuitRig();
    for (const o of ['authorizePit', 'denyPit', 'handoff'] as const) rig.bus.emit('pursuit:order', order({ order: o }));
    rig.bus.emit('pursuit:order', order({ callId: 21 }));
    expect(terminateAdvisories(rig)).toHaveLength(0);
    // The sampler still advises by itself afterwards.
    rig.world.pursuit = { speedMph: 80, limitMph: 35, district: 'downtown', wet: false, night: false, lights: true, siren: true };
    rig.seconds(40);
    expect(rig.advisories).toHaveLength(1);

    const none = new Rig();
    none.world.calls.set(7, callInfo());
    none.bus.emit('scene:materialized', { callId: 7 });
    none.step();
    none.bus.emit('pursuit:order', order());
    expect(none.of(K, 'advisory').filter((a) => a.advisory === 'terminatePursuit')).toHaveLength(0);

    const ended = pursuitRig();
    ended.bus.emit('scene:pursuit', { kind: 'vehicle', active: false, callId: 20, ownerCallId: 7, personId: 5, endReason: 'stopped' });
    ended.bus.emit('pursuit:order', order());
    expect(terminateAdvisories(ended)).toHaveLength(0);
  });

  it('keeps the advised flag in the save', () => {
    const rig = pursuitRig();
    rig.bus.emit('pursuit:order', order());
    const save = JSON.parse(JSON.stringify(rig.sys.serialize())) as ReturnType<typeof rig.sys.serialize>;
    expect(isIncidentsSave(save)).toBe(true);
    expect(save.pursuit).toMatchObject({ callId: 20, advised: true });
  });
});
