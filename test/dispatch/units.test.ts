import { hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { callType } from '../../src/cad/data';
import type { DispatchOfferEvent } from '../../src/cad/events';
import { UNITS_DATA } from '../../src/dispatch/data';
import { beatCentre } from '../../src/dispatch/dispatcher';
import { PoliceLights } from '../../src/police/components';
import { FLEET_ID_BASE, type FleetState } from '../../src/traffic/trafficSystem';
import { vehicleModel } from '../../src/vehicles/model';
import { at, eventsOf, makeHarness, quietConfig, run, runUntil, step, type Harness } from './helpers';

function fleet(): FleetState {
  return { eid: 0, x: 0, z: 0, yaw: 0, speed: 0, edge: 0, mode: 'patrol', arrived: false, parked: false, routeLeftM: -1 };
}

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

describe('dispatcher start', () => {
  it('puts the roster in CAD and one fleet car with PoliceLights near each beat', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const units = h.cad.units();
    expect(units).toHaveLength(7);
    const player = h.cad.playerUnit();
    expect(player).toMatchObject({ callsign: '12', kind: 'player', fleetIndex: -1, beat: 'downtown', status: 'available' });
    const fs = fleet();
    UNITS_DATA.units.forEach((data, i) => {
      const u = h.cad.unit(data.callsign);
      expect(u).toMatchObject({ kind: 'ai', fleetIndex: i, beat: data.beat, officer: data.officer, status: 'available' });
      const state = h.traffic.fleetState(i, fs);
      expect(state).not.toBeNull();
      const beat = beatCentre(h.city, data.beat);
      expect(Math.hypot(fs.x - beat.x, fs.z - beat.z)).toBeLessThan(700);
      expect(h.traffic.vehicleIdOfEntity(fs.eid)).toBe(FLEET_ID_BASE + i);
      expect(h.traffic.view.model[h.traffic.slotOfEntity(fs.eid)]).toBe(vehicleModel(data.model).index);
      expect(hasComponent(h.world, fs.eid, PoliceLights)).toBe(true);
      expect(PoliceLights.phase[fs.eid]).toBeCloseTo(i * 0.37, 5);
      expect(u?.x).toBeCloseTo(fs.x, 3);
    });
  });

  it('keeps fleet cars patrolling (moving, available) with lights synced', async () => {
    const h = await makeHarness({ config: quietConfig() });
    run(h, 30);
    const fs = fleet();
    let moving = 0;
    for (let i = 0; i < 6; i++) {
      h.traffic.fleetState(i, fs);
      if (fs.speed > 1) moving++;
      expect(fs.mode).toBe('patrol');
      expect(PoliceLights.siren[fs.eid]).toBe(0);
      expect(PoliceLights.pattern[fs.eid]).toBe(0);
    }
    expect(moving).toBeGreaterThanOrEqual(3);
    for (const u of h.cad.units()) expect(u.status).toBe('available');
  });
});

describe('assignment and the AI unit FSM', () => {
  it('sends the nearest unit, which goes en route, on scene, closes the call and returns to patrol', async () => {
    const h = await makeHarness({ config: quietConfig(), inPoliceVehicle: false });
    run(h, 2);
    const target = pointAway(h, 900);
    const call = h.dispatcher.createCall('trafficHazard', at(h.sim), target);
    expect(call).not.toBeNull();
    if (!call) return;
    // Distances from each AI unit's AVL position at assignment time.
    const dist = h.cad.units().filter((u) => u.kind === 'ai').map((u) => [u.callsign, Math.hypot(u.x - call.location.x, u.z - call.location.z)] as const);
    const nearest = [...dist].sort((a, b) => a[1] - b[1])[0]?.[0];
    step(h);
    expect(call.status).toBe('active');
    expect(call.units).toEqual([nearest]);
    const unit = h.cad.unit(nearest ?? '');
    expect(unit?.status).toBe('enRoute');
    const fs = fleet();
    h.traffic.fleetState(unit?.fleetIndex ?? -1, fs);
    expect(fs.routeLeftM).toBeGreaterThan(0);
    expect(fs.mode).toBe(call.priority <= 2 ? 'emergency' : 'respond');
    expect(eventsOf(h, 'cad:unitAssigned')).toContainEqual({ callId: call.id, callsign: nearest, by: 'dispatch' });

    expect(runUntil(h, () => unit?.status === 'onScene', 200)).toBe(true);
    expect(call.firstOnScene).not.toBeNull();
    const type = callType('trafficHazard');
    expect(runUntil(h, () => call.status === 'closed', type.onSceneS[1] + 5)).toBe(true);
    expect(type.dispositions).toContain(call.disposition);
    expect(unit?.status).toBe('available');
    expect(unit?.callId).toBeNull();
    step(h);
    h.traffic.fleetState(unit?.fleetIndex ?? -1, fs);
    expect(fs.mode).toBe('patrol');
    expect(h.dispatcher.unitStates().find((s) => s.callsign === nearest)?.mode).toBe('patrol');
  });

  it('assigns p1Units units code 3 to a P1 call', async () => {
    const h = await makeHarness({ config: quietConfig(), inPoliceVehicle: false });
    const call = h.dispatcher.createCall('officerWelfare', at(0), pointAway(h, 600));
    expect(call?.priority).toBe(1);
    step(h);
    expect(call?.units).toHaveLength(2);
    const fs = fleet();
    for (const cs of call?.units ?? []) {
      h.traffic.fleetState(h.cad.unit(cs)?.fleetIndex ?? -1, fs);
      expect(fs.mode).toBe('emergency');
    }
    run(h, 3);
    // Moving code 3 cars sound the wail.
    const sounding = (call?.units ?? []).filter((cs) => {
      h.traffic.fleetState(h.cad.unit(cs)?.fleetIndex ?? -1, fs);
      return fs.speed > 1 && PoliceLights.siren[fs.eid] === 1;
    });
    expect(sounding.length).toBeGreaterThan(0);
  });
});

describe('offers to the player', () => {
  async function offered(): Promise<{ h: Harness; callId: number }> {
    const h = await makeHarness({ config: quietConfig() });
    const call = h.dispatcher.createCall('noiseComplaint', at(0), pointAway(h, 800));
    if (!call) throw new Error('no call');
    step(h);
    return { h, callId: call.id };
  }

  it('offers a nearby call to an available player in a police vehicle; accept assigns the player', async () => {
    const { h, callId } = await offered();
    expect(eventsOf<DispatchOfferEvent>(h, 'dispatch:offer')).toEqual([{ callId, callsign: '12', expired: false }]);
    const call = h.cad.call(callId);
    expect(call?.offeredTo).toBe('12');
    expect(call?.units).toEqual([]);
    h.dispatcher.request('12', { kind: 'acceptCall', callId }, 'mdt');
    step(h);
    expect(call?.units).toEqual(['12']);
    expect(h.cad.playerUnit()?.status).toBe('enRoute');
    expect(eventsOf(h, 'dispatch:ack').at(-1)).toMatchObject({ kind: 'acceptCall', ok: true });
    const dest = { x: 0, z: 0 };
    expect(h.dispatcher.playerDestination(dest)).toBe(true);
    expect(dest).toEqual({ x: call?.location.x, z: call?.location.z });
    // No AI unit is sent to the player's call.
    run(h, 2);
    expect(call?.units).toEqual(['12']);
  });

  it("'status enRoute' with an offer pending accepts it", async () => {
    const { h, callId } = await offered();
    h.dispatcher.request('12', { kind: 'status', status: 'enRoute' }, 'radio');
    step(h);
    expect(h.cad.call(callId)?.units).toEqual(['12']);
  });

  it('decline sends an AI unit and never re-offers the call', async () => {
    const { h, callId } = await offered();
    h.dispatcher.request('12', { kind: 'declineCall', callId }, 'mdt');
    step(h);
    step(h);
    const call = h.cad.call(callId);
    expect(call?.offeredTo).toBeNull();
    expect(call?.units).toHaveLength(1);
    expect(call?.units[0]).not.toBe('12');
    expect(eventsOf<DispatchOfferEvent>(h, 'dispatch:offer')).toHaveLength(1);
  });

  it('times out after offer.timeoutS and goes to AI; answers without an offer are refused', async () => {
    const { h, callId } = await offered();
    h.dispatcher.request('12', { kind: 'acceptCall', callId: callId + 99 }, 'mdt');
    step(h);
    expect(eventsOf(h, 'dispatch:ack').at(-1)).toMatchObject({ kind: 'acceptCall', ok: false });
    run(h, 26);
    expect(eventsOf<DispatchOfferEvent>(h, 'dispatch:offer').at(-1)).toEqual({ callId, callsign: '12', expired: true });
    const call = h.cad.call(callId);
    expect(call?.offeredTo).toBeNull();
    expect(call?.units.length).toBe(1);
    h.dispatcher.request('12', { kind: 'declineCall', callId }, 'mdt');
    step(h);
    expect(eventsOf(h, 'dispatch:ack').at(-1)).toMatchObject({ kind: 'declineCall', ok: false, text: 'No call offered' });
  });

  it('does not offer to a player on foot or out of range', async () => {
    const h = await makeHarness({ config: quietConfig(), inPoliceVehicle: false });
    h.dispatcher.createCall('noiseComplaint', at(0), pointAway(h, 800));
    step(h);
    expect(eventsOf(h, 'dispatch:offer')).toEqual([]);
  });
});
