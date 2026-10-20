import { describe, expect, it } from 'vitest';
import { callType } from '../../src/cad/data';
import type { DispatchBackupEvent } from '../../src/cad/events';
import { HOLD_MAX_S } from '../../src/dispatch/dispatcher';
import { at, clearEvents, eventsOf, makeHarness, quietConfig, run, runUntil, step, type Harness } from './helpers';

/** The player asks for backup; returns the callsign of the first unit sent once it is on scene. */
async function backupOnScene(): Promise<{ h: Harness; cs: string; callId: number }> {
  const h = await makeHarness({ config: quietConfig() });
  clearEvents(h);
  h.dispatcher.request('12', { kind: 'backup', code: 2 }, 'radio');
  step(h);
  const cs = eventsOf<DispatchBackupEvent>(h, 'dispatch:backup').at(-1)?.units[0];
  if (!cs) throw new Error('no backup unit');
  expect(runUntil(h, () => h.cad.unit(cs)?.status === 'onScene', 400)).toBe(true);
  return { h, cs, callId: h.cad.unit(cs)?.callId ?? 0 };
}

function mode(h: Harness, cs: string): string | undefined {
  return h.dispatcher.unitStates().find((s) => s.callsign === cs)?.mode;
}

describe('release holds for an officer on foot', () => {
  it('clearing the call (10-8) leaves the backup car parked while its officer is out, then sends it on patrol', async () => {
    const { h, cs, callId } = await backupOnScene();
    let onFoot = true;
    h.dispatcher.setUnitHold(() => onFoot);
    h.dispatcher.request('12', { kind: 'clearCall', callId, disposition: 'handled' }, 'key');
    step(h);
    expect(h.cad.unit(cs)?.callId).toBeNull();
    expect(mode(h, cs)).toBe('onScene');
    expect(h.dispatcher.releasePending(cs)).toBe(true);
    run(h, 5);
    expect(mode(h, cs)).toBe('onScene');
    // The officer is back in the car: the car leaves.
    onFoot = false;
    run(h, 1);
    expect(mode(h, cs)).toBe('patrol');
    expect(h.dispatcher.releasePending(cs)).toBe(false);
  });

  it('an officer that never gets back does not pin the car for ever (HOLD_MAX_S)', async () => {
    const { h, cs, callId } = await backupOnScene();
    h.dispatcher.setUnitHold(() => true);
    h.dispatcher.request('12', { kind: 'clearCall', callId, disposition: 'handled' }, 'key');
    run(h, HOLD_MAX_S - 3);
    expect(mode(h, cs)).toBe('onScene');
    run(h, 6);
    expect(mode(h, cs)).toBe('patrol');
  });

  it('without a hold the car goes on patrol at once', async () => {
    const { h, cs, callId } = await backupOnScene();
    h.dispatcher.request('12', { kind: 'clearCall', callId, disposition: 'handled' }, 'key');
    step(h);
    expect(mode(h, cs)).toBe('patrol');
  });

  it('going available (10-8 status) holds the car too', async () => {
    const { h, cs } = await backupOnScene();
    h.dispatcher.setUnitHold(() => true);
    h.dispatcher.request('12', { kind: 'status', status: 'available' }, 'key');
    step(h);
    expect(h.cad.unit(cs)?.callId).toBeNull();
    expect(mode(h, cs)).toBe('onScene');
  });

  it('Code 4 marks the release pending at once (the officer starts back) and the car stays until the officer is in', async () => {
    const { h, cs } = await backupOnScene();
    let onFoot = true;
    h.dispatcher.setUnitHold(() => onFoot);
    expect(h.dispatcher.releasePending(cs)).toBe(false);
    h.dispatcher.request('12', { kind: 'code4' }, 'radio');
    step(h);
    expect(h.dispatcher.releasePending(cs)).toBe(true);
    run(h, quietConfig().backup.releaseS + 5);
    expect(h.cad.unit(cs)?.callId).not.toBeNull();
    onFoot = false;
    run(h, 1);
    expect(h.cad.unit(cs)?.callId).toBeNull();
  });

  it('a call unit whose on-scene time is up waits for its officer on foot before it closes the call', async () => {
    const h = await makeHarness({ config: quietConfig(), inPoliceVehicle: false });
    run(h, 2);
    const call = h.dispatcher.createCall('trafficHazard', at(h.sim), pointNear(h));
    if (!call) throw new Error('no call');
    step(h);
    const cs = call.units[0] ?? '';
    expect(cs).not.toBe('');
    expect(runUntil(h, () => h.cad.unit(cs)?.status === 'onScene', 300)).toBe(true);
    let onFoot = true;
    h.dispatcher.setUnitHold(() => onFoot);
    const type = callType('trafficHazard');
    expect(runUntil(h, () => h.dispatcher.releasePending(cs), type.onSceneS[1] + 5)).toBe(true);
    run(h, 10);
    expect(call.status).not.toBe('closed');
    expect(h.dispatcher.releasePending(cs)).toBe(true);
    onFoot = false;
    run(h, 1);
    expect(call.status).toBe('closed');
  });

  it('the backup retarget leaves a car alone while its officer is on foot', async () => {
    const { h, cs } = await backupOnScene();
    h.dispatcher.setUnitHold((c) => c === cs);
    h.player.x += 400;
    run(h, 30);
    expect(h.cad.unit(cs)?.status).toBe('onScene');
    h.dispatcher.setUnitHold(null);
    h.player.x += 1; // keep moving: the retarget runs again
    run(h, 30);
    expect(h.cad.unit(cs)?.status).toBe('enRoute');
  });

  it('the backup acknowledgement carries the soonest ETA when the ranker is set', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.setUnitRanker((c) => (c === '21' ? 95 : 130));
    clearEvents(h);
    h.dispatcher.request('12', { kind: 'backup', code: 3 }, 'radio');
    step(h);
    const e = eventsOf<DispatchBackupEvent>(h, 'dispatch:backup').at(-1);
    expect(e?.etaS).toBeGreaterThan(0);
    expect(e?.etaS).toBeLessThanOrEqual(130);
    h.dispatcher.setUnitRanker(null);
    clearEvents(h);
    h.dispatcher.request('12', { kind: 'code4' }, 'radio');
    run(h, 60);
    clearEvents(h);
    h.dispatcher.request('12', { kind: 'backup', code: 2 }, 'radio');
    step(h);
    expect(eventsOf<DispatchBackupEvent>(h, 'dispatch:backup').at(-1)?.etaS).toBe(-1);
  });
});

function pointNear(h: Harness): { x: number; z: number } {
  for (const e of h.city.graph.edges) {
    const p = e.points;
    const x = ((p[0] ?? 0) + (p[p.length - 2] ?? 0)) / 2;
    const z = ((p[1] ?? 0) + (p[p.length - 1] ?? 0)) / 2;
    const r = Math.hypot(x - h.player.x, z - h.player.z);
    if (r > 500 && r < 700 && h.city.districtAt(x, z) !== 10) return { x, z };
  }
  throw new Error('no point');
}
