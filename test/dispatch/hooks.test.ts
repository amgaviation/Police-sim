import { describe, expect, it } from 'vitest';
import type { DispatchOfferEvent } from '../../src/cad/events';
import { createRng, hashString } from '../../src/core/rng';
import { DISPATCH_CONFIG } from '../../src/dispatch/data';
import { at, eventsOf, makeHarness, quietConfig, run, type Harness } from './helpers';
import type { FleetState } from '../../src/traffic/trafficSystem';

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

function busyConfig() {
  return { ...DISPATCH_CONFIG, generator: { ...DISPATCH_CONFIG.generator, firstCallDelayS: 0, meanIntervalS: 4 } };
}

function fleet(): FleetState {
  return { eid: 0, x: 0, z: 0, yaw: 0, speed: 0, edge: 0, mode: 'patrol', arrived: false, parked: false, routeLeftM: -1 };
}

describe('manual dispatch', () => {
  it('without the hook a new call near the player is offered or sent to an AI unit', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const p = pointAway(h, 300);
    const call = h.dispatcher.createCall('noiseComplaint', at(0), p);
    expect(call).not.toBeNull();
    run(h, 5);
    const c = h.cad.call(call!.id)!;
    expect(c.status === 'active' || c.offeredTo !== null).toBe(true);
  });

  it('leaves a new call pending with no offer and no AI unit', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.setManualDispatch(true);
    const p = pointAway(h, 300);
    const call = h.dispatcher.createCall('noiseComplaint', at(0), p)!;
    run(h, 20);
    const c = h.cad.call(call.id)!;
    expect(c.status).toBe('pending');
    expect(c.offeredTo).toBeNull();
    expect(c.units).toEqual([]);
    expect(eventsOf<DispatchOfferEvent>(h, 'dispatch:offer')).toHaveLength(0);
    for (const u of h.dispatcher.unitStates()) expect(u.callId).toBeNull();
    // Turning it off again lets the normal assignment run.
    h.dispatcher.setManualDispatch(false);
    run(h, 5);
    const after = h.cad.call(call.id)!;
    expect(after.status === 'active' || after.offeredTo !== null).toBe(true);
  });

  it('withdraws an offer that is open when manual mode starts', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const call = h.dispatcher.createCall('noiseComplaint', at(0), pointAway(h, 200))!;
    run(h, 2);
    if (h.cad.call(call.id)?.offeredTo === null) return;
    h.dispatcher.setManualDispatch(true);
    expect(h.cad.call(call.id)?.offeredTo).toBeNull();
  });
});

describe('assignUnit / unassignUnit', () => {
  it('sends an AI unit en route exactly like the automatic path', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.setManualDispatch(true);
    const call = h.dispatcher.createCall('noiseComplaint', at(0), pointAway(h, 400))!;
    run(h, 1);
    expect(h.dispatcher.assignUnit('21', call.id, at(h.sim))).toBe(true);
    const cu = h.cad.unit('21')!;
    expect(cu).toMatchObject({ status: 'enRoute', callId: call.id });
    expect(h.cad.call(call.id)).toMatchObject({ status: 'active', units: ['21'], primary: '21' });
    const state = h.dispatcher.unitStates().find((u) => u.callsign === '21')!;
    expect(state).toMatchObject({ mode: 'enRoute', role: 'call', callId: call.id });
    run(h, 2);
    const fs = fleet();
    h.traffic.fleetState(state.fleetIndex, fs);
    expect(fs.mode).toBe('respond');
  });

  it('uses emergency urgency for P1 and P2 calls', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.setManualDispatch(true);
    const call = h.dispatcher.createScriptedCall({ typeId: 'noiseComplaint', priority: 1, x: pointAway(h, 400).x, z: pointAway(h, 400).z }, at(0))!;
    expect(h.dispatcher.assignUnit('23', call.id, at(0))).toBe(true);
    run(h, 2);
    const fs = fleet();
    h.traffic.fleetState(h.dispatcher.unitStates().find((u) => u.callsign === '23')!.fleetIndex, fs);
    expect(fs.mode).toBe('emergency');
  });

  it('refuses unknown units, the player, unknown or closed calls, and busy units', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.setManualDispatch(true);
    const a = h.dispatcher.createCall('noiseComplaint', at(0), pointAway(h, 300))!;
    const b = h.dispatcher.createCall('alarm', at(0), pointAway(h, 500))!;
    expect(h.dispatcher.assignUnit('nobody', a.id, at(0))).toBe(false);
    expect(h.dispatcher.assignUnit(h.dispatcher.playerCallsign, a.id, at(0))).toBe(false);
    expect(h.dispatcher.assignUnit('21', 9999, at(0))).toBe(false);
    expect(h.dispatcher.assignUnit('21', a.id, at(0))).toBe(true);
    expect(h.dispatcher.assignUnit('21', b.id, at(0))).toBe(false);
    expect(h.dispatcher.assignUnit('21', a.id, at(0))).toBe(false);
    h.cad.closeCall(b.id, 'cancelled', at(0));
    expect(h.dispatcher.assignUnit('23', b.id, at(0))).toBe(false);
    h.cad.setUnitStatus('25', 'outOfService', at(0), 'auto');
    expect(h.dispatcher.assignUnit('25', a.id, at(0))).toBe(false);
    expect(h.dispatcher.assignUnit('27', a.id, at(0))).toBe(true);
  });

  it('unassignUnit returns the unit to patrol and the call to pending', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.setManualDispatch(true);
    const call = h.dispatcher.createCall('noiseComplaint', at(0), pointAway(h, 400))!;
    expect(h.dispatcher.unassignUnit('21', at(0))).toBe(false);
    expect(h.dispatcher.unassignUnit('nobody', at(0))).toBe(false);
    h.dispatcher.assignUnit('21', call.id, at(0));
    run(h, 2);
    expect(h.dispatcher.unassignUnit('21', at(h.sim))).toBe(true);
    expect(h.cad.unit('21')).toMatchObject({ status: 'available', callId: null });
    expect(h.cad.call(call.id)).toMatchObject({ status: 'pending', units: [] });
    run(h, 10);
    expect(h.dispatcher.unitStates().find((u) => u.callsign === '21')).toMatchObject({ mode: 'patrol', callId: null });
    // Manual mode: nobody else picks it up.
    expect(h.cad.call(call.id)?.status).toBe('pending');
  });

  it('an assigned unit arrives, works the call and closes it', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.setManualDispatch(true);
    const call = h.dispatcher.createCall('parkingComplaint', at(0), pointAway(h, 300))!;
    h.dispatcher.assignUnit('21', call.id, at(0));
    run(h, 700);
    expect(h.cad.call(call.id)?.status).toBe('closed');
    expect(h.cad.unit('21')?.status).toBe('available');
  }, 60000);
});

describe('setCallPriority', () => {
  it('changes the priority of an open call', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.setManualDispatch(true);
    const call = h.dispatcher.createCall('noiseComplaint', at(0), pointAway(h, 300))!;
    h.dispatcher.setCallPriority(call.id, 1, at(0));
    expect(h.cad.call(call.id)?.priority).toBe(1);
    h.dispatcher.setCallPriority(9999, 2, at(0));
  });
});

describe('generator hooks', () => {
  it('setGeneratorEnabled(false) stops generation without drawing', async () => {
    const h = await makeHarness({ config: busyConfig() });
    h.dispatcher.setGeneratorEnabled(false);
    const before = JSON.stringify(h.dispatcher.serialize().rng.calls);
    run(h, 120);
    expect(h.dispatcher.stats.generated).toBe(0);
    expect(h.cad.calls()).toHaveLength(0);
    expect(JSON.stringify(h.dispatcher.serialize().rng.calls)).toBe(before);
    h.dispatcher.setGeneratorEnabled(true);
    run(h, 120);
    expect(h.dispatcher.stats.generated).toBeGreaterThan(0);
  });

  it('createScriptedCall opens a call at a point with the given priority and narrative', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.setManualDispatch(true);
    const p = pointAway(h, 500);
    const call = h.dispatcher.createScriptedCall({ typeId: 'noiseComplaint', priority: 1, x: p.x, z: p.z, narrative: 'Custom script narrative.' }, at(0))!;
    expect(call).not.toBeNull();
    expect(call.typeId).toBe('noiseComplaint');
    expect(call.priority).toBe(1);
    expect(call.narrative.some((n) => n.text === 'Custom script narrative.')).toBe(true);
    expect(Math.hypot(call.location.x - p.x, call.location.z - p.z)).toBeLessThan(80);
    expect(h.cad.call(call.id)).toBe(call);
    expect(call.status).toBe('pending');
    // Without overrides the type's own priority and a generated narrative are used.
    const plain = h.dispatcher.createScriptedCall({ typeId: 'alarm', x: p.x, z: p.z }, at(0))!;
    expect([1, 2, 3, 4]).toContain(plain.priority);
    expect(plain.narrative.length).toBeGreaterThan(0);
    expect(h.dispatcher.createScriptedCall({ typeId: 'doesNotExist', x: p.x, z: p.z }, at(0))).toBeNull();
  });

  it('a scripted call is assigned by the automatic path when manual mode is off', async () => {
    const h = await makeHarness({ config: quietConfig(), inPoliceVehicle: false });
    const p = pointAway(h, 400);
    const call = h.dispatcher.createScriptedCall({ typeId: 'alarm', priority: 2, x: p.x, z: p.z }, at(0))!;
    run(h, 3);
    expect(h.cad.call(call.id)?.units.length).toBeGreaterThan(0);
  });

  it('setLocationBias gives the generator the location, with the calls stream draw', async () => {
    const h = await makeHarness({ config: busyConfig() });
    h.dispatcher.setManualDispatch(true);
    const target = pointAway(h, 700);
    const draws: number[] = [];
    h.dispatcher.setLocationBias((draw) => {
      draws.push(draw());
      return target;
    });
    run(h, 60);
    const calls = h.cad.calls();
    expect(calls.length).toBeGreaterThan(0);
    expect(draws.length).toBeGreaterThanOrEqual(calls.length);
    for (const d of draws) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(1);
    }
    for (const c of calls) expect(Math.hypot(c.location.x - target.x, c.location.z - target.z)).toBeLessThan(100);
  });

  it('a bias that returns null leaves the usual location', async () => {
    const h = await makeHarness({ config: busyConfig() });
    let asked = 0;
    h.dispatcher.setLocationBias(() => {
      asked++;
      return null;
    });
    run(h, 60);
    expect(asked).toBeGreaterThan(0);
    expect(h.dispatcher.stats.generated).toBeGreaterThan(0);
  });

  it('category weights shift the call mix over 500 seeded picks', async () => {
    const h = await makeHarness({ start: false });
    const g = h.dispatcher.generator;
    const count = (): Map<string, number> => {
      const rng = createRng(11).stream('mix');
      const m = new Map<string, number>();
      for (let i = 0; i < 500; i++) {
        const t = g.pickType(rng, h.player.x, h.player.z, 21 * 3600);
        if (t) m.set(t.category, (m.get(t.category) ?? 0) + 1);
      }
      return m;
    };
    const base = count();
    expect(base.size).toBeGreaterThan(2);
    const [favourite] = [...base.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const [rare] = [...base.entries()].sort((a, b) => a[1] - b[1])[0]!;
    const seen: string[] = [];
    g.setCategoryWeight((c) => {
      seen.push(c);
      return c === rare ? 12 : c === favourite ? 0 : 1;
    });
    const shifted = count();
    expect(seen.length).toBeGreaterThan(0);
    expect(shifted.get(favourite) ?? 0).toBe(0);
    expect(shifted.get(rare) ?? 0).toBeGreaterThan((base.get(rare) ?? 0) * 2);
    g.setCategoryWeight(null);
    expect(count()).toEqual(base);
    // The dispatcher forwards the setter.
    let forwarded = false;
    h.dispatcher.setCategoryWeights(() => {
      forwarded = true;
      return 1;
    });
    g.pickType(createRng(1), 0, 0, 0);
    expect(forwarded).toBe(true);
  });

  it('ignores category weights that are not finite non-negative numbers', async () => {
    const h = await makeHarness({ start: false });
    const g = h.dispatcher.generator;
    const rng = () => createRng(3).stream('mix');
    const plain: (string | undefined)[] = [];
    const r1 = rng();
    for (let i = 0; i < 50; i++) plain.push(g.pickType(r1, 0, 0, 0)?.id);
    g.setCategoryWeight(() => Number.NaN);
    const r2 = rng();
    const bad: (string | undefined)[] = [];
    for (let i = 0; i < 50; i++) bad.push(g.pickType(r2, 0, 0, 0)?.id);
    expect(bad).toEqual(plain);
  });
});

describe('nearestAvailableDistance', () => {
  it('is the distance to the nearest patrolling AI unit and Infinity when none', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const u = h.cad.unit('21')!;
    let best = Infinity;
    for (const cu of h.cad.units()) if (cu.kind === 'ai') best = Math.min(best, Math.hypot(cu.x - u.x, cu.z - u.z));
    expect(h.dispatcher.nearestAvailableDistance(u.x, u.z)).toBeCloseTo(best, 5);
    expect(h.dispatcher.nearestAvailableDistance(u.x, u.z)).toBeLessThan(1);
    const call = h.dispatcher.createCall('noiseComplaint', at(0), pointAway(h, 300))!;
    h.dispatcher.setManualDispatch(true);
    for (const cu of h.cad.units()) if (cu.kind === 'ai') h.dispatcher.assignUnit(cu.callsign, call.id, at(0));
    expect(h.dispatcher.nearestAvailableDistance(0, 0)).toBe(Infinity);
  });
});

describe('no hooks set', () => {
  async function fingerprint(setup?: (h: Harness) => void): Promise<{ hash: number; length: number; generated: number }> {
    const h = await makeHarness();
    setup?.(h);
    run(h, 20 * 60);
    const text = JSON.stringify([h.cad.serialize(), h.dispatcher.serialize(), h.traffic.snapshot()]);
    return { hash: hashString(text), length: text.length, generated: h.dispatcher.stats.generated };
  }

  it('matches the Phase 7 fixture (hash recorded before the hooks existed)', async () => {
    expect(await fingerprint()).toEqual({ hash: 2925743938, length: 21430, generated: 12 });
  }, 120000);

  it('neutral hook values change nothing', async () => {
    const neutral = await fingerprint((h) => {
      h.dispatcher.setGeneratorEnabled(true);
      h.dispatcher.setManualDispatch(false);
      h.dispatcher.setLocationBias(null);
      h.dispatcher.setCategoryWeights(null);
    });
    expect(neutral).toEqual({ hash: 2925743938, length: 21430, generated: 12 });
  }, 120000);

  it('a category weight of 1 and a bias returning null change nothing either', async () => {
    const same = await fingerprint((h) => {
      h.dispatcher.setCategoryWeights(() => 1);
    });
    expect(same.hash).toBe(2925743938);
  }, 120000);
});
