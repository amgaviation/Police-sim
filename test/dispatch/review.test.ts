import { describe, expect, it } from 'vitest';
import type { DispatchAckEvent } from '../../src/cad/events';
import { DISPATCH_CONFIG } from '../../src/dispatch/data';
import { isFleetVehicleId, type StopState } from '../../src/traffic/trafficSystem';
import { at, eventsOf, makeHarness, quietConfig, run, runUntil, step, type Harness } from './helpers';

function lastAck(h: Harness): DispatchAckEvent | undefined {
  return eventsOf<DispatchAckEvent>(h, 'dispatch:ack').at(-1);
}

/** Pulls the nearest ambient car over with the player behind it. */
async function stopped(): Promise<Harness> {
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
  const s: StopState = { vehicleId: -1, eid: 0, phase: 'pulling', x: 0, z: 0, yaw: 0 };
  const ok = runUntil(h, () => {
    if (h.traffic.stopState(s)) {
      h.player.x = s.x - 8;
      h.player.z = s.z;
    }
    return h.cad.trafficStop?.outcome === 'active';
  }, 60);
  if (!ok) throw new Error('car did not pull over');
  return h;
}

describe('10-8 / 10-7 clear the player call', () => {
  it('10-8 during an active stop releases the car and closes the stop call (no AI unit sent)', async () => {
    const h = await stopped();
    const callId = h.cad.trafficStop?.callId ?? -1;
    h.dispatcher.request('12', { kind: 'status', status: 'available' }, 'voice');
    run(h, 10);
    expect(h.cad.trafficStop?.outcome).toBe('released');
    expect(h.traffic.stopVehicleId).toBe(-1);
    expect(h.cad.call(callId)).toMatchObject({ status: 'closed', disposition: 'handled', units: ['12'] });
    expect(h.cad.playerUnit()).toMatchObject({ status: 'available', callId: null });
  });

  it('10-8 after an arrest closes the stop call as arrestMade', async () => {
    const h = await stopped();
    const callId = h.cad.trafficStop?.callId ?? -1;
    h.dispatcher.request('12', { kind: 'stopContact', action: 'arrest' }, 'mdt');
    step(h);
    h.dispatcher.request('12', { kind: 'status', status: 'available' }, 'key');
    run(h, 10);
    expect(h.cad.call(callId)).toMatchObject({ status: 'closed', disposition: 'arrestMade' });
  });

  it('10-8 on a call the player handles alone closes it with the type default (10-7 from a call is refused)', async () => {
    const h = await makeHarness({ config: quietConfig() });
    for (const status of ['outOfService', 'available'] as const) {
      const call = h.dispatcher.createCall('noiseComplaint', at(h.sim), { x: h.player.x + 50, z: h.player.z });
      if (!call) throw new Error('no call');
      h.dispatcher.request('12', { kind: 'selfAssign', callId: call.id }, 'mdt');
      step(h);
      h.dispatcher.request('12', { kind: 'status', status: 'onScene' }, 'mdt');
      step(h);
      h.dispatcher.request('12', { kind: 'status', status }, 'radio');
      run(h, 10);
      if (status === 'outOfService') {
        expect(lastAck(h)).toMatchObject({ kind: 'status', ok: false });
        expect(h.cad.call(call.id)).toMatchObject({ status: 'active', units: ['12'] });
        h.dispatcher.request('12', { kind: 'clearCall', callId: call.id, disposition: 'handled' }, 'mdt');
        step(h);
        continue;
      }
      expect(h.cad.call(call.id)).toMatchObject({ status: 'closed', disposition: 'handled', units: ['12'] });
      expect(h.cad.playerUnit()?.status).toBe('available');
    }
  });

  it('with AI units also on the call, 10-8 only takes the player off it', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const call = h.dispatcher.createCall('minorCollision', at(h.sim), { x: h.player.x + 3000, z: h.player.z });
    if (!call) throw new Error('no call');
    expect(runUntil(h, () => (h.cad.call(call.id)?.units.length ?? 0) > 0, 10)).toBe(true);
    h.dispatcher.request('12', { kind: 'selfAssign', callId: call.id }, 'mdt');
    step(h);
    h.dispatcher.request('12', { kind: 'status', status: 'available' }, 'radio');
    step(h);
    const c = h.cad.call(call.id);
    expect(c?.status).toBe('active');
    expect(c?.units).not.toContain('12');
    expect(c?.units.length).toBeGreaterThan(0);
  });
});

describe('assignment guards', () => {
  it('refuses self-assign while out of service or on an active stop', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.request('12', { kind: 'status', status: 'outOfService' }, 'mdt');
    step(h);
    const call = h.dispatcher.createCall('noiseComplaint', at(h.sim), { x: h.player.x + 50, z: h.player.z });
    if (!call) throw new Error('no call');
    h.dispatcher.request('12', { kind: 'selfAssign', callId: call.id }, 'mdt');
    step(h);
    expect(lastAck(h)).toMatchObject({ kind: 'selfAssign', ok: false });
    expect(h.cad.playerUnit()).toMatchObject({ status: 'outOfService', callId: null });
    expect(h.cad.assign(call.id, '12', at(h.sim), 'self')).toBe(false);

    const s = await stopped();
    const stopCall = s.cad.trafficStop?.callId ?? -1;
    const other = s.dispatcher.createCall('noiseComplaint', at(s.sim), { x: s.player.x + 50, z: s.player.z });
    if (!other) throw new Error('no call');
    s.dispatcher.request('12', { kind: 'selfAssign', callId: other.id }, 'mdt');
    step(s);
    expect(lastAck(s)).toMatchObject({ kind: 'selfAssign', ok: false, text: 'Clear the traffic stop first' });
    expect(s.cad.playerUnit()?.callId).toBe(stopCall);
    expect(s.cad.trafficStop?.outcome).toBe('active');
    run(s, 5);
    expect(s.cad.call(stopCall)?.units).toEqual(['12']);
  });

  it('withdraws a pending offer when the player self-assigns another call; "en route" keeps the current call', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const b = h.dispatcher.createCall('noiseComplaint', at(h.sim), { x: h.player.x + 100, z: h.player.z });
    if (!b) throw new Error('no call');
    run(h, 2);
    expect(h.cad.call(b.id)?.offeredTo).toBe('12');
    const a = h.dispatcher.createCall('alarm', at(h.sim), { x: h.player.x + 200, z: h.player.z });
    if (!a) throw new Error('no call');
    h.dispatcher.request('12', { kind: 'selfAssign', callId: a.id }, 'mdt');
    step(h);
    expect(h.cad.call(b.id)?.offeredTo).toBeNull();
    h.dispatcher.request('12', { kind: 'status', status: 'onScene' }, 'radio');
    step(h);
    h.dispatcher.request('12', { kind: 'status', status: 'enRoute' }, 'radio');
    run(h, 3);
    expect(h.cad.playerUnit()?.callId).toBe(a.id);
    expect(h.cad.call(a.id)?.units).toEqual(['12']);
    expect(h.cad.call(b.id)?.units).not.toContain('12');
  });
});

describe('AI unit arrival', () => {
  it('marks AI units on scene only near the scene (forced arrival needs a lack of progress)', async () => {
    const config = { ...DISPATCH_CONFIG, generator: { ...DISPATCH_CONFIG.generator, firstCallDelayS: 5 } };
    const h = await makeHarness({ density: 0, config });
    const far: string[] = [];
    let arrivals = 0;
    h.bus.on('cad:unitStatus', (e) => {
      if (e.status !== 'onScene' || e.callsign === '12' || e.callId === null) return;
      const call = h.cad.call(e.callId);
      const u = h.cad.unit(e.callsign);
      if (!call || !u) return;
      arrivals++;
      const d = Math.hypot(u.x - call.location.x, u.z - call.location.z);
      if (d > 400) far.push(`${e.callsign}@${h.sim.toFixed(0)}s d=${d.toFixed(0)}`);
    });
    run(h, 900);
    expect(arrivals).toBeGreaterThan(0);
    expect(far).toEqual([]);
  }, 120_000);
});
