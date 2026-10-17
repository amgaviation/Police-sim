import { describe, expect, it } from 'vitest';
import type { DispatchAckEvent, DispatchPlateResultEvent } from '../../src/cad/events';
import { isFleetVehicleId, type StopState } from '../../src/traffic/trafficSystem';
import { eventsOf, makeHarness, quietConfig, run, runUntil, step, type Harness } from './helpers';

function stopState(): StopState {
  return { vehicleId: -1, eid: 0, phase: 'pulling', x: 0, z: 0, yaw: 0 };
}

/** Forces the nearest ambient car (not `skip`) to pull over with the player 8 m behind; its id, -1 when none stops. */
function pullOverNearest(h: Harness, skip = -1): number {
  const v = h.traffic.view;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < v.count; i++) {
    const id = v.vehicleId[i] ?? 0;
    if (isFleetVehicleId(id) || id === skip) continue;
    const d = Math.hypot((v.x[i] ?? 0) - h.player.x, (v.z[i] ?? 0) - h.player.z);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  if (best < 0 || !h.traffic.forceStop(best)) return -1;
  const s = stopState();
  let pulled = false;
  const off = h.bus.on('traffic:pulledOver', (e) => {
    if (e.vehicleId === best) pulled = true;
  });
  const ok = runUntil(
    h,
    () => {
      if (h.traffic.stopState(s) && s.vehicleId === best) {
        h.player.x = s.x - 8;
        h.player.z = s.z;
      }
      return pulled;
    },
    60,
  );
  off();
  step(h);
  return ok ? best : -1;
}

describe('dispatcher review round 3', () => {
  it('10-8 while still en route returns a dispatched call to the queue instead of closing it', async () => {
    const h = await makeHarness({ config: quietConfig(), density: 0 });
    const call = h.dispatcher.createCall('noiseComplaint', { sim: h.sim, game: 0 }, { x: h.player.x + 1500, z: h.player.z });
    if (!call) throw new Error('no call');
    h.dispatcher.request('12', { kind: 'selfAssign', callId: call.id }, 'mdt');
    step(h);
    expect(h.cad.playerUnit()?.status).toBe('enRoute');
    h.dispatcher.request('12', { kind: 'status', status: 'available' }, 'mdt');
    step(h);
    expect(h.cad.playerUnit()?.status).toBe('available');
    expect(h.cad.playerUnit()?.callId).toBeNull();
    const c = h.cad.call(call.id);
    expect(c?.status).not.toBe('closed');
    expect(c?.disposition ?? null).toBeNull();
    // An AI unit picks it up.
    run(h, 5);
    expect(h.cad.call(call.id)?.units.some((u) => u !== '12')).toBe(true);
  });

  it('a pull-over after an arrest is refused while the arrest stop call is open', async () => {
    const h = await makeHarness({ config: quietConfig(), density: 1 });
    run(h, 1);
    const first = pullOverNearest(h);
    expect(first).toBeGreaterThanOrEqual(0);
    const stop = h.cad.trafficStop;
    if (!stop) throw new Error('no stop');
    h.dispatcher.request('12', { kind: 'stopContact', action: 'arrest' }, 'mdt');
    step(h);
    step(h);
    expect(h.cad.trafficStop?.outcome).toBe('arrest');
    expect(h.cad.playerUnit()?.status).toBe('onScene');
    const other = pullOverNearest(h, first);
    expect(other).toBeGreaterThanOrEqual(0);
    run(h, 5);
    expect(eventsOf<DispatchAckEvent>(h, 'dispatch:ack').at(-1)).toMatchObject({ kind: 'trafficStop', ok: false });
    expect(h.cad.trafficStop?.callId).toBe(stop.callId);
    expect(h.cad.trafficStop?.outcome).toBe('arrest');
    expect(h.cad.call(stop.callId)).toMatchObject({ status: 'active', units: ['12'] });
    expect(h.cad.playerUnit()?.callId).toBe(stop.callId);
  });

  it('a stop plate run with no vehicle id is run against the stop car', async () => {
    const h = await makeHarness({ config: quietConfig(), density: 1 });
    run(h, 1);
    const id = pullOverNearest(h);
    const stop = h.cad.trafficStop;
    if (!stop || id < 0) throw new Error('no stop');
    h.dispatcher.request('12', { kind: 'runPlate', plate: stop.plate.replace(' ', ''), vehicleId: -1 }, 'voice');
    step(h);
    const r = eventsOf<DispatchPlateResultEvent>(h, 'dispatch:plateResult').at(-1);
    expect(r?.vehicleId).toBe(stop.vehicleId);
    expect(h.cad.trafficStop?.plateRun).toBe(true);
    expect(eventsOf<DispatchAckEvent>(h, 'dispatch:ack').some((a) => a.kind === 'runPlate' && !a.ok)).toBe(false);
  });
});
