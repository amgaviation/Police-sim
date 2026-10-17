import { describe, expect, it } from 'vitest';
import type { CadUnitAssignedEvent, DispatchAckEvent } from '../../src/cad/events';
import { callType } from '../../src/cad/data';
import { at, eventsOf, makeHarness, quietConfig, run, runUntil, step, type Harness } from './helpers';

/** A road point about `d` m from the player (first edge midpoint in that ring). */
function pointAway(h: Harness, d: number): { x: number; z: number } {
  for (const e of h.city.graph.edges) {
    const p = e.points;
    const x = ((p[0] ?? 0) + (p[p.length - 2] ?? 0)) / 2;
    const z = ((p[1] ?? 0) + (p[p.length - 1] ?? 0)) / 2;
    const r = Math.hypot(x - h.player.x, z - h.player.z);
    if (r > d * 0.8 && r < d * 1.2 && h.city.districtAt(x, z) !== 10) return { x, z };
  }
  throw new Error('no point');
}

describe('dispatcher review round 2', () => {
  it('a call that needs two AI units closes, and each unit is assigned to it at most once', async () => {
    const h = await makeHarness({ config: quietConfig(), inPoliceVehicle: false });
    const call = h.dispatcher.createCall('officerAssist', at(0), pointAway(h, 300));
    if (!call) throw new Error('no call');
    const range = callType('officerAssist').onSceneS;
    const closed = runUntil(h, () => h.cad.call(call.id)?.status === 'closed', range[1] + 600);
    expect(closed).toBe(true);
    const assigned = eventsOf<CadUnitAssignedEvent>(h, 'cad:unitAssigned').filter((e) => e.callId === call.id).map((e) => e.callsign);
    expect(assigned.length).toBeGreaterThanOrEqual(2);
    expect(new Set(assigned).size).toBe(assigned.length);
    // Units back on patrol, free for new calls.
    for (const cs of assigned) expect(h.cad.unit(cs)?.callId).toBeNull();
  }, 60_000);

  it('a pull-over never takes the player off a call they are assigned to', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const call = h.dispatcher.createCall('alarm', at(0), pointAway(h, 600));
    if (!call) throw new Error('no call');
    h.dispatcher.request('12', { kind: 'selfAssign', callId: call.id }, 'mdt');
    run(h, 1);
    expect(h.cad.playerUnit()?.callId).toBe(call.id);
    h.bus.emit('traffic:pulledOver', { eid: 0, vehicleId: 123, x: h.player.x + 10, z: h.player.z, yaw: 0 });
    run(h, 1);
    expect(h.cad.playerUnit()?.callId).toBe(call.id);
    expect(h.cad.trafficStop).toBeNull();
    expect(h.cad.call(call.id)?.units).toEqual(['12']);
    const ack = eventsOf<DispatchAckEvent>(h, 'dispatch:ack').at(-1);
    expect(ack).toMatchObject({ kind: 'trafficStop', ok: false });
    expect(ack?.text).toContain(call.number);
  });

  it('reconciles CAD with the roster after a load (unit added to or removed from units.json)', async () => {
    const h = await makeHarness({ config: quietConfig() });
    run(h, 10);
    const cadSave = h.cad.serialize();
    const dispatchSave = h.dispatcher.serialize();
    const ai = h.cad.units().filter((u) => u.kind === 'ai');
    const last = ai.at(-1)?.callsign ?? '';
    // An older save without the last roster unit, plus a unit no longer in the roster.
    cadSave.units = cadSave.units.filter((u) => u.callsign !== last);
    const ghost = { ...(cadSave.units.find((u) => u.kind === 'ai') ?? cadSave.units[0]), callsign: '99', fleetIndex: 40 } as (typeof cadSave.units)[number];
    cadSave.units.push(ghost);
    dispatchSave.units = dispatchSave.units.filter((u) => u.callsign !== last);
    h.cad.restore(cadSave);
    expect(h.cad.unit(last)).toBeNull();
    h.dispatcher.restore(dispatchSave, at(h.sim));
    expect(h.cad.unit(last)).toMatchObject({ kind: 'ai', status: 'available' });
    expect(h.cad.unit('99')).toBeNull();
    expect(h.cad.units().filter((u) => u.kind === 'ai').map((u) => u.callsign)).toEqual(ai.map((u) => u.callsign));
    // It keeps reporting its position (AVL) like the others.
    run(h, 5);
    step(h);
    const u = h.cad.unit(last);
    expect(u?.x !== 0 || u?.z !== 0).toBe(true);
  });
});
