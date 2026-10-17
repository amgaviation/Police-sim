import { describe, expect, it } from 'vitest';
import { addressAt } from '../../src/cad/address';
import type {
  DispatchAckEvent,
  DispatchBackupEvent,
  DispatchEmergencyEvent,
  DispatchLocationEvent,
  DispatchPlateResultEvent,
} from '../../src/cad/events';
import { plateSummary } from '../../src/records/db';
import { PLATE_FLAG, mountedPlate, observedVehicle, plateFlags } from '../../src/records/vehicle';
import type { FleetState } from '../../src/traffic/trafficSystem';
import { LIGHT, VehicleLook } from '../../src/vehicles/components';
import { at, eventsOf, makeHarness, quietConfig, run, runUntil, step, type Harness } from './helpers';

function fleet(): FleetState {
  return { eid: 0, x: 0, z: 0, yaw: 0, speed: 0, edge: 0, mode: 'patrol', arrived: false, parked: false, routeLeftM: -1 };
}

function lastAck(h: Harness): DispatchAckEvent | undefined {
  return eventsOf<DispatchAckEvent>(h, 'dispatch:ack').at(-1);
}

/** First registry id whose true plate state has `flag`. */
function vehicleWith(seed: number, flag: number, start = 0): number {
  for (let id = start; id < 60000; id++) if ((plateFlags(seed, id) & flag) !== 0) return id;
  throw new Error('none');
}

describe('status requests', () => {
  it('applies allowed transitions and refuses others with ack ok false', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.request('12', { kind: 'status', status: 'transporting' }, 'radio');
    step(h);
    expect(lastAck(h)).toMatchObject({ callsign: '12', kind: 'status', ok: false });
    expect(h.cad.playerUnit()?.status).toBe('available');
    h.dispatcher.request('12', { kind: 'status', status: 'busy' }, 'radio');
    step(h);
    expect(lastAck(h)).toEqual({ callsign: '12', kind: 'status', ok: true, text: '10-6 BUSY' });
    expect(h.cad.playerUnit()?.status).toBe('busy');
    const statuses = eventsOf<{ via: string; status: string }>(h, 'cad:unitStatus');
    expect(statuses.at(-1)).toMatchObject({ status: 'busy', via: 'radio' });
  });

  it('rejects requests from unknown units and for unknown calls', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.request('99', { kind: 'code4' }, 'radio');
    h.dispatcher.request('12', { kind: 'selfAssign', callId: 42 }, 'mdt');
    h.dispatcher.request('12', { kind: 'clearCall', callId: 42, disposition: 'handled' }, 'mdt');
    h.dispatcher.request('12', { kind: 'narrative', callId: 42, text: 'x' }, 'mdt');
    h.dispatcher.request('12', { kind: 'stopContact', action: 'license' }, 'mdt');
    h.dispatcher.request('12', { kind: 'trafficStop' }, 'radio');
    h.dispatcher.request('12', { kind: 'runPerson', personId: -5 }, 'mdt');
    step(h);
    const acks = eventsOf<DispatchAckEvent>(h, 'dispatch:ack');
    expect(acks.map((a) => [a.callsign, a.kind, a.ok])).toEqual([
      ['99', 'code4', false],
      ['12', 'selfAssign', false],
      ['12', 'clearCall', false],
      ['12', 'narrative', false],
      ['12', 'stopContact', false],
      ['12', 'trafficStop', false],
      ['12', 'runPerson', false],
    ]);
  });

  it('queues unit:request bus events like direct requests; self-assign, narrative and clear work', async () => {
    const h = await makeHarness({ config: quietConfig(), inPoliceVehicle: false });
    const call = h.dispatcher.createCall('alarm', at(0), { x: h.player.x + 400, z: h.player.z });
    if (!call) throw new Error('no call');
    step(h);
    h.bus.emit('unit:request', { callsign: '12', request: { kind: 'selfAssign', callId: call.id }, via: 'mdt' });
    expect(call.units).not.toContain('12');
    step(h);
    expect(call.units).toContain('12');
    h.dispatcher.request('12', { kind: 'narrative', callId: call.id, text: 'Front door secure.' }, 'mdt');
    step(h);
    expect(call.narrative.at(-1)).toMatchObject({ source: '12', text: 'Front door secure.' });
    h.dispatcher.request('12', { kind: 'clearCall', callId: call.id, disposition: 'bogus' }, 'mdt');
    step(h);
    expect(lastAck(h)).toMatchObject({ kind: 'clearCall', ok: false });
    // An AI unit is also on the call: the player only leaves it.
    expect(call.units.filter((cs) => cs !== '12').length).toBeGreaterThan(0);
    h.dispatcher.request('12', { kind: 'clearCall', callId: call.id, disposition: 'unfounded' }, 'mdt');
    step(h);
    expect(call.status).toBe('active');
    expect(call.units).not.toContain('12');
    expect(h.cad.playerUnit()?.status).toBe('available');
  });

  it('closes the call when the player is the last unit', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const call = h.dispatcher.createCall('noiseComplaint', at(0), { x: h.player.x + 400, z: h.player.z });
    if (!call) throw new Error('no call');
    step(h);
    h.dispatcher.request('12', { kind: 'acceptCall', callId: call.id }, 'mdt');
    h.dispatcher.request('12', { kind: 'status', status: 'onScene' }, 'mdt');
    h.dispatcher.request('12', { kind: 'clearCall', callId: call.id, disposition: 'warningIssued' }, 'mdt');
    step(h);
    expect(call.status).toBe('closed');
    expect(call.disposition).toBe('warningIssued');
    expect(lastAck(h)).toMatchObject({ kind: 'clearCall', ok: true });
  });
});

describe('plate and person runs', () => {
  it('reads back exactly what records returns, with the observed vehicle', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const id = 1234;
    const plate = mountedPlate(h.seed, id).plate;
    h.dispatcher.request('12', { kind: 'runPlate', plate, vehicleId: id }, 'key');
    step(h);
    const res = eventsOf<DispatchPlateResultEvent>(h, 'dispatch:plateResult');
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ callsign: '12', via: 'key', vehicleId: id });
    expect(res[0]?.readback).toEqual(plateSummary(h.records.runPlate(plate, observedVehicle(h.seed, id))));
    expect(eventsOf(h, 'dispatch:ack')).toEqual([]);
  });

  it('flags anomalous vehicles: stolen -> alert, cloned / expired -> at least caution', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const stolen = vehicleWith(h.seed, PLATE_FLAG.stolen);
    const cloned = vehicleWith(h.seed, PLATE_FLAG.cloned);
    const mismatched = vehicleWith(h.seed, PLATE_FLAG.mismatched);
    const expired = vehicleWith(h.seed, PLATE_FLAG.expired);
    for (const id of [stolen, cloned, mismatched, expired]) {
      h.dispatcher.request('12', { kind: 'runPlate', plate: mountedPlate(h.seed, id).plate, vehicleId: id }, 'key');
    }
    // A typed plate (no observed vehicle) and an unknown plate.
    h.dispatcher.request('12', { kind: 'runPlate', plate: mountedPlate(h.seed, stolen).plate.replace(' ', '').toLowerCase(), vehicleId: -1 }, 'mdt');
    h.dispatcher.request('12', { kind: 'runPlate', plate: 'ZZ', vehicleId: -1 }, 'mdt');
    step(h);
    const res = eventsOf<DispatchPlateResultEvent>(h, 'dispatch:plateResult').map((r) => r.readback);
    expect(res).toHaveLength(6);
    expect(res[0]?.severity).toBe('alert');
    expect(res[0]?.hits.some((t) => t.includes('STOLEN'))).toBe(true);
    expect(res[1]?.severity).not.toBe('clear');
    expect(res[2]?.severity).toBe('alert');
    expect(res[2]?.hits.some((t) => t.includes('MISMATCH'))).toBe(true);
    expect(res[3]?.severity).not.toBe('clear');
    expect(res[4]?.severity).toBe('alert');
    expect(res[5]?.found).toBe(false);
  });

  it('runs a person', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.request('12', { kind: 'runPerson', personId: 777 }, 'mdt');
    step(h);
    const res = eventsOf<{ readback: unknown; via: string }>(h, 'dispatch:personResult');
    expect(res).toEqual([{ callsign: '12', via: 'mdt', readback: h.records.personSummary(777) }]);
  });
});

describe('backup, emergency, location', () => {
  it('backup code 3 sends the two nearest units code 3 to the player (light bars on)', async () => {
    const h = await makeHarness({ config: quietConfig() });
    run(h, 1);
    h.dispatcher.request('12', { kind: 'backup', code: 3 }, 'radio');
    step(h);
    const ev = eventsOf<DispatchBackupEvent>(h, 'dispatch:backup');
    expect(ev).toHaveLength(1);
    expect(ev[0]?.code).toBe(3);
    expect(ev[0]?.units).toHaveLength(2);
    const ai = h.cad.units().filter((u) => u.kind === 'ai');
    const sorted = [...ai].sort((a, b) => Math.hypot(a.x - h.player.x, a.z - h.player.z) - Math.hypot(b.x - h.player.x, b.z - h.player.z));
    expect(new Set(ev[0]?.units)).toEqual(new Set(sorted.slice(0, 2).map((u) => u.callsign)));
    const call = h.cad.call(h.cad.playerUnit()?.callId ?? -1);
    expect(call?.typeId).toBe('officerAssist');
    expect(call?.priority).toBe(1);
    expect(call?.units).toEqual(expect.arrayContaining(['12', ...(ev[0]?.units ?? [])]));
    expect(h.cad.playerUnit()?.status).toBe('onScene');
    run(h, 1);
    const fs = fleet();
    for (const cs of ev[0]?.units ?? []) {
      h.traffic.fleetState(h.cad.unit(cs)?.fleetIndex ?? -1, fs);
      expect(fs.mode).toBe('emergency');
      expect((VehicleLook.lights[fs.eid] ?? 0) & LIGHT.lightbar).toBe(LIGHT.lightbar);
      expect(h.cad.unit(cs)?.status).toBe('enRoute');
    }
  });

  it('backup code 2 pre-empts a P3/P4 unit when nobody is free, and reports none when all are out of service', async () => {
    const h = await makeHarness({ config: quietConfig() });
    for (const u of h.cad.units()) if (u.kind === 'ai') h.cad.setUnitStatus(u.callsign, 'outOfService', at(0), 'auto');
    h.dispatcher.request('12', { kind: 'backup', code: 2 }, 'radio');
    step(h);
    expect(eventsOf<DispatchBackupEvent>(h, 'dispatch:backup')[0]?.units).toEqual([]);
    expect(lastAck(h)).toEqual({ callsign: '12', kind: 'backup', ok: false, text: 'No units available' });

    const g = await makeHarness({ config: quietConfig(), inPoliceVehicle: false });
    const ai = g.cad.units().filter((u) => u.kind === 'ai');
    for (const u of ai.slice(1)) g.cad.setUnitStatus(u.callsign, 'outOfService', at(0), 'auto');
    const low = g.dispatcher.createCall('parkingComplaint', at(0), { x: g.player.x + 300, z: g.player.z });
    step(g);
    expect(low?.units).toEqual([ai[0]?.callsign]);
    g.dispatcher.request('12', { kind: 'backup', code: 2 }, 'radio');
    step(g);
    expect(eventsOf<DispatchBackupEvent>(g, 'dispatch:backup')[0]?.units).toEqual([ai[0]?.callsign]);
    expect(low?.units).toEqual([]);
    expect(low?.status).toBe('pending');
  });

  it('emergency: flag, P1 officerEmergency call, units code 3; code 4 ends it and releases the units', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.request('12', { kind: 'emergency' }, 'key');
    step(h);
    const em = eventsOf<DispatchEmergencyEvent>(h, 'dispatch:emergency');
    expect(em).toHaveLength(1);
    expect(em[0]).toMatchObject({ callsign: '12', active: true });
    expect(em[0]?.units).toHaveLength(3);
    expect(h.cad.playerUnit()?.emergency).toBe(true);
    const call = h.cad.calls().find((c) => c.typeId === 'officerEmergency');
    expect(call?.priority).toBe(1);
    expect(call?.units).toEqual(em[0]?.units);
    h.dispatcher.request('12', { kind: 'emergency' }, 'key');
    step(h);
    expect(lastAck(h)).toMatchObject({ kind: 'emergency', ok: false });

    h.dispatcher.request('12', { kind: 'code4' }, 'radio');
    step(h);
    expect(eventsOf<DispatchEmergencyEvent>(h, 'dispatch:emergency').at(-1)).toMatchObject({ active: false });
    expect(h.cad.playerUnit()?.emergency).toBe(false);
    expect(lastAck(h)?.kind).not.toBe('code4');
    run(h, 29);
    expect(call?.status).not.toBe('closed');
    run(h, 2);
    expect(call?.status).toBe('closed');
    for (const cs of em[0]?.units ?? []) expect(h.cad.unit(cs)?.status).toBe('available');
    h.dispatcher.request('12', { kind: 'code4' }, 'radio');
    step(h);
    expect(lastAck(h)).toEqual({ callsign: '12', kind: 'code4', ok: true, text: 'Code 4' });
  });

  it('backup units follow the player and are released 30 s after code 4', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.request('12', { kind: 'backup', code: 2 }, 'radio');
    step(h);
    const cs = eventsOf<DispatchBackupEvent>(h, 'dispatch:backup')[0]?.units[0] ?? '';
    const call = h.cad.call(h.cad.playerUnit()?.callId ?? -1);
    h.player.x += 200;
    run(h, 6);
    h.dispatcher.request('12', { kind: 'code4' }, 'radio');
    step(h);
    run(h, 31);
    expect(h.cad.unit(cs)?.callId).toBeNull();
    expect(call?.units).toEqual(['12']);
    expect(call?.status).toBe('active');
  });

  it('answers a 10-20 with the near text of the player address', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.request('12', { kind: 'location' }, 'radio');
    step(h);
    const loc = eventsOf<DispatchLocationEvent>(h, 'dispatch:location');
    const addr = addressAt(h.city.graph, h.player.x, h.player.z, undefined, 2000);
    expect(loc).toHaveLength(1);
    expect(loc[0]?.asked).toBe(false);
    expect(loc[0]?.text).toContain(addr?.street ?? '???');
    expect(eventsOf(h, 'dispatch:ack')).toEqual([]);
  });

  it('records AVL positions for AI units and the player every avlIntervalS', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const rev = h.cad.avlRevision;
    run(h, 2);
    // Ticks at 0.5, 1.0 and 1.5 s, seven units each.
    expect(h.cad.avlRevision - rev).toBe(3 * 7);
    h.player.x += 50;
    expect(runUntil(h, () => h.cad.playerUnit()?.x === h.player.x, 1)).toBe(true);
    const fs = fleet();
    h.traffic.fleetState(0, fs);
    expect(Math.hypot((h.cad.unit('21')?.x ?? 0) - fs.x, (h.cad.unit('21')?.z ?? 0) - fs.z)).toBeLessThan(12);
  });
});
