import { describe, expect, it } from 'vitest';
import { driverOf } from '../../src/records/vehicle';
import { isFleetVehicleId, type StopState } from '../../src/traffic/trafficSystem';
import { makeHarness, quietConfig, run, runUntil, step, type Harness } from './helpers';

function stopState(): StopState {
  return { vehicleId: -1, eid: 0, phase: 'pulling', x: 0, z: 0, yaw: 0 };
}

/** Makes the nearest ambient car pull over (the player follows it) and returns its registry id. */
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

describe('traffic stop driver follows the world occupant', () => {
  it('uses the resolver for the booked subject', async () => {
    const { h, vehicleId } = await stopped();
    const other = (driverOf(h.seed, vehicleId) + 1234) % 100000;
    h.dispatcher.setDriverResolver(() => other);
    h.dispatcher.request('12', { kind: 'stopContact', action: 'license' }, 'mdt');
    step(h);
    expect(h.cad.trafficStop).toMatchObject({ trueDriverId: other, driverId: other });
  });
});
