import { hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { isDispatchSave, isUnitRequest, type DispatchSave } from '../../src/dispatch/save';
import { PoliceLights } from '../../src/police/components';
import type { FleetState } from '../../src/traffic/trafficSystem';
import { makeHarness, quietConfig, run, step, type Harness } from './helpers';

function json<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function fleet(): FleetState {
  return { eid: 0, x: 0, z: 0, yaw: 0, speed: 0, edge: 0, mode: 'patrol', arrived: false, parked: false, routeLeftM: -1 };
}

function state(h: Harness): unknown {
  return {
    cad: h.cad.serialize(),
    dispatch: h.dispatcher.serialize(),
    traffic: h.traffic.snapshot(),
    records: h.records.serialize(),
  };
}

/** A fresh world restored from `a`'s saves (load order: traffic, cad, records, dispatch). */
async function restoredFrom(a: Harness, density: number): Promise<Harness> {
  const saves = json({ cad: a.cad.serialize(), dispatch: a.dispatcher.serialize(), traffic: a.traffic.snapshot(), records: a.records.serialize() });
  const b = await makeHarness({ start: false, density, player: { x: a.player.x, z: a.player.z } });
  b.sim = a.sim;
  b.traffic.restore(saves.traffic);
  b.cad.restore(saves.cad);
  b.records.restore(saves.records);
  expect(isDispatchSave(saves.dispatch)).toBe(true);
  b.dispatcher.restore(saves.dispatch);
  return b;
}

describe('dispatch save', () => {
  it('validates its own blocks and rejects malformed ones', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.request('12', { kind: 'backup', code: 3 }, 'radio');
    h.bus.emit('traffic:fleetArrived', { index: 2, eid: 1, x: 0, z: 0 });
    const save = json(h.dispatcher.serialize());
    expect(isDispatchSave(save)).toBe(true);
    expect(save.requests).toEqual([{ callsign: '12', request: { kind: 'backup', code: 3 }, via: 'radio' }]);
    expect(save.events).toEqual([{ type: 'fleetArrived', index: 2 }]);
    const bad: ((s: DispatchSave) => void)[] = [
      (s) => ((s as { version: number }).version = 2),
      (s) => (s.rng.calls = { seed: 1, s: [1, 2, 3] as unknown as [number, number, number, number] }),
      (s) => (s.units[0]!.mode = 'flying' as never),
      (s) => (s.units[1]!.fleetIndex = s.units[0]!.fleetIndex),
      (s) => (s.units[0]!.timers.onSceneUntil = Number.NaN),
      (s) => (s.offer.callId = -7),
      (s) => (s.requests[0]!.request = { kind: 'backup', code: 4 } as never),
      (s) => (s.events[0] = { type: 'boom' } as never),
      (s) => (s.plans = [[0, 1]]),
    ];
    for (const mutate of bad) {
      const copy = json(save);
      mutate(copy);
      expect(isDispatchSave(copy)).toBe(false);
    }
    expect(isDispatchSave(null)).toBe(false);
    expect(isUnitRequest({ kind: 'stopContact', action: 'license' })).toBe(true);
    expect(isUnitRequest({ kind: 'stopContact', action: 'dance' })).toBe(false);
  });

  it('continues exactly after save/load (2 sim minutes, then 1 more in both worlds)', async () => {
    const density = 0.5;
    const a = await makeHarness({ density });
    run(a, 60);
    a.dispatcher.request('12', { kind: 'backup', code: 3 }, 'radio');
    run(a, 60);
    // A request still queued at save time is applied after the load.
    a.dispatcher.request('12', { kind: 'location' }, 'radio');
    const b = await restoredFrom(a, density);
    expect(state(b)).toEqual(state(a));
    for (let i = 0; i < 3600; i++) {
      step(a);
      step(b);
    }
    expect(a.cad.calls().length).toBeGreaterThan(1);
    expect(state(b)).toEqual(state(a));
    // PoliceLights were re-attached to the restored fleet cars.
    const fs = fleet();
    for (let i = 0; i < 6; i++) {
      expect(b.traffic.fleetState(i, fs)).not.toBeNull();
      expect(hasComponent(b.world, fs.eid, PoliceLights)).toBe(true);
    }
  });

  it('dispose unsubscribes from the bus', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const before = h.bus.listenerCount();
    h.dispatcher.dispose();
    expect(before - h.bus.listenerCount()).toBe(5);
    h.bus.emit('unit:request', { callsign: '12', request: { kind: 'code4' }, via: 'radio' });
    expect(h.dispatcher.serialize().requests).toEqual([]);
  });
});
