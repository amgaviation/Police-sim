import { describe, expect, it } from 'vitest';
import { CALL_TYPES } from '../../src/cad/data';
import { catalogCadRows } from '../../src/calls';
import { createRng } from '../../src/core/rng';
import { isDispatchSave, isUnitRequest } from '../../src/dispatch/save';
import { canBeOnRoad } from '../../src/records/vehicle';
import { isFleetVehicleId, type StopState } from '../../src/traffic/trafficSystem';
import { at, clearEvents, makeHarness, quietConfig, run, runUntil, type Harness } from './helpers';

const DAY = 86400;
const FRIDAY_2AM = DAY * 4 + 2 * 3600;
const FRIDAY_10AM = DAY * 4 + 10 * 3600;

const PHASE3_IDS = new Set((catalogCadRows() as { id: string }[]).map((r) => r.id));

describe('generator weights by game time', () => {
  it('generates Phase 3 types (and only generated ones)', async () => {
    const h = await makeHarness({ start: false });
    const g = h.dispatcher.generator;
    const rng = createRng(11);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const t = g.pickType(rng, h.player.x, h.player.z, FRIDAY_2AM + (i % 24) * 3600);
      expect(t).not.toBeNull();
      expect(t!.generated).toBe(true);
      seen.add(t!.id);
    }
    const phase3 = [...seen].filter((id) => PHASE3_IDS.has(id));
    expect(phase3.length).toBeGreaterThan(60);
    expect(CALL_TYPES.length).toBeGreaterThanOrEqual(175);
  });

  it('draws more DUI-category calls at 02:00 than at 10:00 (2000 seeded calls each)', async () => {
    const h = await makeHarness({ start: false });
    const g = h.dispatcher.generator;
    const share = (game: number): number => {
      const rng = createRng(3);
      let dui = 0;
      for (let i = 0; i < 2000; i++) if (g.pickType(rng, h.player.x, h.player.z, game)?.category === 'dui') dui++;
      return dui / 2000;
    };
    const night = share(FRIDAY_2AM);
    const morning = share(FRIDAY_10AM);
    expect(night).toBeGreaterThan(morning);
    expect(night).toBeGreaterThan(0);
  });

  it('{plate} / {vehicle} placeholders use cars that can be on the road', async () => {
    const h = await makeHarness({ start: false });
    const g = h.dispatcher.generator;
    const withPlate = CALL_TYPES.filter((t) => t.narratives.some((n) => n.includes('{plate}')));
    expect(withPlate.length).toBeGreaterThan(0);
    const rng = createRng(21);
    let cars = 0;
    for (let i = 0; i < 300; i++) {
      const type = withPlate[i % withPlate.length]!;
      const c = g.generate(rng, h.player.x, h.player.z, '12', FRIDAY_10AM, type);
      if (!c) continue;
      for (const v of c.vehicles) {
        cars++;
        expect(canBeOnRoad(h.seed, v)).toBe(true);
      }
    }
    expect(cars).toBeGreaterThan(50);
  });
});

function stopState(): StopState {
  return { vehicleId: -1, eid: 0, phase: 'pulling', x: 0, z: 0, yaw: 0 };
}

async function stopped(): Promise<{ h: Harness; vehicleId: number }> {
  const h = await makeHarness({ config: quietConfig(), density: 1 });
  run(h, 1);
  const v = h.traffic.view;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < v.count; i++) {
    const id = v.vehicleId[i] ?? 0;
    if (isFleetVehicleId(id)) continue;
    const d = Math.hypot((v.x[i] ?? 0) - h.player.x, (v.z[i] ?? 0) - h.player.z);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  if (best < 0 || !h.traffic.forceStop(best)) throw new Error('no car to stop');
  const s = stopState();
  const ok = runUntil(
    h,
    () => {
      if (h.traffic.stopState(s)) {
        h.player.x = s.x - 8;
        h.player.z = s.z;
      }
      return h.cad.trafficStop?.outcome === 'active';
    },
    60,
  );
  if (!ok) throw new Error('car did not pull over');
  return { h, vehicleId: best };
}

describe('stopContact license with a claimed identity', () => {
  it('uses personId when given (the claimed person, even when it is not the driver)', async () => {
    const { h } = await stopped();
    const stop = h.cad.trafficStop!;
    const other = (stop.trueDriverId + 17) % 1000;
    h.dispatcher.request('12', { kind: 'stopContact', action: 'license', personId: other }, 'radio');
    run(h, 0.2);
    expect(h.cad.trafficStop?.driverId).toBe(other);
    expect(h.cad.trafficStop?.trueDriverId).toBe(stop.trueDriverId);
    const call = h.cad.call(stop.callId)!;
    expect(call.persons).toContain(other);
    const name = h.records.person(other);
    expect(call.narrative.at(-1)?.text.toUpperCase()).toContain(name.last.toUpperCase());
    expect(h.events.filter((e) => e.topic === 'dispatch:personResult').at(-1)?.payload).toMatchObject({ readback: { personId: other } });
  });

  it('falls back to the true driver without a claim (absent, -1 or out of range)', async () => {
    for (const personId of [undefined, -1, 99_999_999]) {
      const { h } = await stopped();
      const stop = h.cad.trafficStop!;
      const request = personId === undefined ? ({ kind: 'stopContact', action: 'license' } as const) : ({ kind: 'stopContact', action: 'license', personId } as const);
      h.dispatcher.request('12', request, 'radio');
      run(h, 0.2);
      expect(h.cad.trafficStop?.driverId).toBe(stop.trueDriverId);
    }
  });

  it('the request validator accepts and checks the claimed id', () => {
    expect(isUnitRequest({ kind: 'stopContact', action: 'license', personId: 5 })).toBe(true);
    expect(isUnitRequest({ kind: 'stopContact', action: 'license', personId: -1 })).toBe(true);
    expect(isUnitRequest({ kind: 'stopContact', action: 'license', personId: 'x' })).toBe(false);
    expect(isUnitRequest({ kind: 'stopContact', action: 'license', personId: 1.5 })).toBe(false);
  });
});

describe('openSelfInitiated', () => {
  it('opens a self-initiated call with the player on scene and no AI plan', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const call = h.dispatcher.openSelfInitiated('pedestrianStop', 4, { x: h.player.x, z: h.player.z }, 'Field contact test.', at(0), [7], [3]);
    expect(call.selfInitiated).toBe(true);
    expect(call.typeId).toBe('pedestrianStop');
    expect(call.persons).toEqual([7]);
    expect(call.vehicles).toEqual([3]);
    expect(call.units).toEqual(['12']);
    expect(call.status).toBe('active');
    expect(call.narrative[0]?.text).toBe('Field contact test.');
    expect(h.cad.playerUnit()?.status).toBe('onScene');
    expect(h.cad.playerUnit()?.callId).toBe(call.id);
    run(h, 60);
    // No AI unit is sent to a self-initiated call.
    expect(call.units).toEqual(['12']);
    expect(h.dispatcher.unitStates().every((u) => u.callId !== call.id)).toBe(true);
  });

  it('a dispatched call the player leaves for it goes back to the AI units and is not stranded', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const a = h.dispatcher.createCall('loudParty', at(0), { x: h.player.x, z: h.player.z })!;
    h.dispatcher.request('12', { kind: 'selfAssign', callId: a.id }, 'key');
    run(h, 1);
    expect(h.cad.playerUnit()?.callId).toBe(a.id);
    const b = h.dispatcher.openSelfInitiated('footPursuit', 2, { x: h.player.x, z: h.player.z }, 'Foot pursuit.', at(h.sim));
    expect(h.cad.playerUnit()?.callId).toBe(b.id);
    clearEvents(h);
    run(h, 300);
    const aa = h.cad.call(a.id)!;
    expect(aa.units).not.toContain('12');
    expect(aa.status === 'closed' || aa.units.length > 0).toBe(true);
  });

  it('a self-initiated call the player leaves for another one is closed', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const a = h.dispatcher.openSelfInitiated('pedestrianStop', 3, { x: h.player.x, z: h.player.z }, 'Field contact.', at(0));
    const b = h.dispatcher.openSelfInitiated('footPursuit', 2, { x: h.player.x, z: h.player.z }, 'Foot pursuit.', at(h.sim));
    expect(h.cad.playerUnit()?.callId).toBe(b.id);
    expect(h.cad.call(a.id)?.status).toBe('closed');
  });
});

describe('fled stops and owned stops', () => {
  it("a stop whose car flees ends as lost with a 'fled' narrative", async () => {
    const { h, vehicleId } = await stopped();
    const stop = h.cad.trafficStop!;
    expect(h.traffic.flee(vehicleId)).toBe(true);
    run(h, 0.3);
    expect(h.cad.trafficStop?.outcome).toBe('lost');
    const call = h.cad.call(stop.callId)!;
    expect(call.status).toBe('closed');
    expect(call.disposition).toBe('reportTaken');
    expect(call.narrative.some((n) => n.text === 'Stopped vehicle fled from the stop.')).toBe(true);
  });

  it('the dispatch save accepts a queued fled release', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.bus.emit('traffic:released', { eid: 1, vehicleId: 5, reason: 'fled' });
    const save = JSON.parse(JSON.stringify(h.dispatcher.serialize())) as ReturnType<typeof h.dispatcher.serialize>;
    expect(save.events).toEqual([{ type: 'released', vehicleId: 5, reason: 'fled' }]);
    expect(isDispatchSave(save)).toBe(true);
  });

  it('a stop on a car the current call owns attaches to that call instead of being refused', async () => {
    const h = await makeHarness({ config: quietConfig(), density: 1 });
    run(h, 1);
    const v = h.traffic.view;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < v.count; i++) {
      const id = v.vehicleId[i] ?? 0;
      if (isFleetVehicleId(id)) continue;
      const d = Math.hypot((v.x[i] ?? 0) - h.player.x, (v.z[i] ?? 0) - h.player.z);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    const call = h.dispatcher.createCall('loudParty', at(h.sim), { x: h.player.x, z: h.player.z })!;
    h.dispatcher.request('12', { kind: 'selfAssign', callId: call.id }, 'key');
    run(h, 1);
    // Without an owner the stop is refused.
    expect(h.traffic.forceStop(best)).toBe(true);
    const s = stopState();
    runUntil(h, () => { if (h.traffic.stopState(s)) { h.player.x = s.x - 8; h.player.z = s.z; } return h.cad.trafficStop !== null || h.traffic.stopVehicleId < 0; }, 60);
    expect(h.cad.trafficStop).toBeNull();
    // With an owner it runs on the call.
    h.dispatcher.setStopOwner((callId, vehicleId) => callId === call.id && vehicleId === best);
    expect(h.traffic.forceStop(best)).toBe(true);
    expect(runUntil(h, () => { if (h.traffic.stopState(s)) { h.player.x = s.x - 8; h.player.z = s.z; } return h.cad.trafficStop?.outcome === 'active'; }, 60)).toBe(true);
    expect(h.cad.trafficStop?.callId).toBe(call.id);
    expect(h.cad.playerUnit()?.callId).toBe(call.id);
    expect(h.cad.call(call.id)?.narrative.some((n) => n.text.startsWith('Vehicle stopped, plate'))).toBe(true);
  });
});
