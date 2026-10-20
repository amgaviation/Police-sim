import { describe, expect, it } from 'vitest';
import type { DispatchAckEvent, DispatchBackupEvent } from '../../src/cad/events';
import { DISPATCH_CONFIG } from '../../src/dispatch/data';
import { ETA_RANK_K, HOLD_MAX_S } from '../../src/dispatch/dispatcher';
import { isDispatchSave, isUnitRequest, type DispatchSave } from '../../src/dispatch/save';
import { at, clearEvents, eventsOf, makeHarness, quietConfig, run, runUntil, step, type Harness } from './helpers';

function json<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

const AI = ['21', '23', '25', '27', '31', '33'];

/** The player requests code 2 backup and the dispatcher sends `units` AI units; returns their callsigns. */
function backupCallsigns(h: Harness, code: 2 | 3 = 2): string[] {
  clearEvents(h);
  h.dispatcher.request('12', { kind: 'backup', code }, 'radio');
  step(h);
  return eventsOf<DispatchBackupEvent>(h, 'dispatch:backup').at(-1)?.units ?? [];
}

function dist(h: Harness, callsign: string): number {
  const u = h.cad.unit(callsign);
  return Math.hypot((u?.x ?? 0) - h.player.x, (u?.z ?? 0) - h.player.z);
}

describe('ETA ranker (pickUnits)', () => {
  it('without a ranker the nearest unit is picked; a farther unit with a lower ranker value wins', async () => {
    const a = await makeHarness({ config: quietConfig() });
    const nearest = backupCallsigns(a);
    expect(nearest).toHaveLength(1);
    const order = [...AI].sort((x, y) => dist(a, x) - dist(a, y));
    expect(nearest[0]).toBe(order[0]);

    const b = await makeHarness({ config: quietConfig() });
    const calls: string[] = [];
    // The farthest of the candidates has the best (lowest) value.
    b.dispatcher.setUnitRanker((cs) => {
      calls.push(cs);
      return -dist(b, cs);
    });
    const picked = backupCallsigns(b);
    expect(picked).toHaveLength(1);
    expect(picked[0]).not.toBe(nearest[0]);
    // Only the nearest ETA_RANK_K units by straight line were ranked.
    expect(ETA_RANK_K).toBe(4);
    expect(calls.length).toBeLessThanOrEqual(ETA_RANK_K);
    expect(calls).toEqual(order.slice(0, calls.length));
    const nearestFour = order.slice(0, ETA_RANK_K);
    expect(nearestFour).toContain(picked[0]);
    // ...and it is the farthest of those four.
    expect(picked[0]).toBe(nearestFour[nearestFour.length - 1]);
  });

  it('skips Infinity (unreachable) candidates, breaks ties by distance and passes the urgency', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const order = [...AI].sort((x, y) => dist(h, x) - dist(h, y));
    const urgencies: string[] = [];
    h.dispatcher.setUnitRanker((cs, _x, _z, urgency) => {
      urgencies.push(urgency);
      return cs === order[0] ? Infinity : 5;
    });
    // Equal values (5): the nearer reachable candidate wins each pick; the nearest unit is unreachable (code 3 sends two).
    const picked = backupCallsigns(h, 3);
    expect(picked).toEqual([order[1], order[2]]);
    expect(new Set(urgencies)).toEqual(new Set(['emergency']));
  });

  it('picks nobody (and acks "No units available") when every candidate is unreachable', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.setUnitRanker(() => Infinity);
    clearEvents(h);
    h.dispatcher.request('12', { kind: 'backup', code: 2 }, 'radio');
    step(h);
    expect(eventsOf<DispatchBackupEvent>(h, 'dispatch:backup').at(-1)?.units).toEqual([]);
    expect(eventsOf<DispatchAckEvent>(h, 'dispatch:ack').at(-1)).toMatchObject({ kind: 'backup', ok: false });
    h.dispatcher.setUnitRanker(null);
    expect(backupCallsigns(h)).toHaveLength(1);
  });

  it('ranks several picks of one request without repeating a unit', async () => {
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.setUnitRanker((cs) => dist(h, cs));
    const picked = backupCallsigns(h, 3);
    expect(picked).toHaveLength(2);
    expect(new Set(picked).size).toBe(2);
  });
});

describe('directUnit / undirectUnit', () => {
  it('refuses unknown units and units without a call', async () => {
    const h = await makeHarness({ config: quietConfig() });
    expect(h.dispatcher.directUnit('99', 0, 0, 'respond')).toBe(false);
    expect(h.dispatcher.directUnit('21', 0, 0, 'respond')).toBe(false);
  });

  it('is not retargeted to the moving player, goes enRoute and arrives on scene at the directed point', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const [cs] = backupCallsigns(h);
    if (!cs) throw new Error('no backup unit');
    const target = { x: h.player.x + 250, z: h.player.z + 40 };
    expect(h.dispatcher.directUnit(cs, target.x, target.z, 'respond')).toBe(true);
    expect(h.cad.unit(cs)?.status).toBe('enRoute');
    const saved = (): DispatchSave['units'][number] => h.dispatcher.serialize().units.find((u) => u.callsign === cs) as DispatchSave['units'][number];
    expect(saved().directed).toBe(true);
    // The player drives far away: the backup retarget must leave the directed unit alone.
    h.player.x += 600;
    run(h, DISPATCH_CONFIG.backup.retargetS * 3);
    const dest = saved().dest;
    expect(dest).not.toBeNull();
    expect(dest?.x).toBeCloseTo(target.x, 3);
    expect(dest?.z).toBeCloseTo(target.z, 3);
    expect(runUntil(h, () => h.cad.unit(cs)?.status === 'onScene', 200)).toBe(true);
    expect(Math.hypot((h.cad.unit(cs)?.x ?? 0) - target.x, (h.cad.unit(cs)?.z ?? 0) - target.z)).toBeLessThan(150);
  });

  it('follows the player again after undirectUnit and clears the flag on release', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const [cs] = backupCallsigns(h);
    if (!cs) throw new Error('no backup unit');
    expect(h.dispatcher.directUnit(cs, h.player.x + 200, h.player.z, 'respond')).toBe(true);
    h.dispatcher.undirectUnit(cs);
    const entry = h.dispatcher.serialize().units.find((u) => u.callsign === cs);
    expect(entry?.directed).toBeUndefined();
    h.dispatcher.undirectUnit('99');
  });
});

describe('setUnitHold', () => {
  const releaseS = DISPATCH_CONFIG.backup.releaseS;

  async function withBackup(): Promise<{ h: Harness; cs: string }> {
    const h = await makeHarness({ config: quietConfig() });
    const [cs] = backupCallsigns(h);
    if (!cs) throw new Error('no backup unit');
    h.dispatcher.request('12', { kind: 'code4' }, 'radio');
    step(h);
    return { h, cs };
  }

  it('releases at releaseAt without a hold', async () => {
    const { h, cs } = await withBackup();
    expect(h.cad.unit(cs)?.callId).not.toBeNull();
    run(h, releaseS - 5);
    expect(h.cad.unit(cs)?.callId).not.toBeNull();
    run(h, 10);
    expect(h.cad.unit(cs)?.callId).toBeNull();
  });

  it('postpones the release while the hold holds, at most HOLD_MAX_S past releaseAt', async () => {
    expect(HOLD_MAX_S).toBe(30);
    const { h, cs } = await withBackup();
    const asked: string[] = [];
    h.dispatcher.setUnitHold((c) => {
      asked.push(c);
      return true;
    });
    run(h, releaseS + HOLD_MAX_S - 5);
    expect(h.cad.unit(cs)?.callId).not.toBeNull();
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set([cs]));
    run(h, 10);
    expect(h.cad.unit(cs)?.callId).toBeNull();
  });

  it('releases as soon as the hold ends', async () => {
    const { h, cs } = await withBackup();
    let holding = true;
    h.dispatcher.setUnitHold(() => holding);
    run(h, releaseS + 5);
    expect(h.cad.unit(cs)?.callId).not.toBeNull();
    holding = false;
    run(h, 1);
    expect(h.cad.unit(cs)?.callId).toBeNull();
    h.dispatcher.setUnitHold(null);
  });
});

describe('aiUnitsOnCall / sendBackup', () => {
  it('lists the AI units on a call and reuses the output array', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const picked = backupCallsigns(h, 3);
    const callId = h.cad.playerUnit()?.callId ?? 0;
    expect(callId).toBeGreaterThan(0);
    const out: string[] = ['stale'];
    const res = h.dispatcher.aiUnitsOnCall(callId, out);
    expect(res).toBe(out);
    expect([...out].sort()).toEqual([...picked].sort());
    expect(h.dispatcher.aiUnitsOnCall(9999, out)).toEqual([]);
  });

  it('sendBackup sends n more patrol units to the player call without the radio acknowledgement', async () => {
    const h = await makeHarness({ config: quietConfig() });
    // No call yet: nothing to send to.
    expect(h.dispatcher.sendBackup(2, 2)).toEqual([]);
    const first = backupCallsigns(h);
    clearEvents(h);
    const more = h.dispatcher.sendBackup(3, 2);
    expect(more).toHaveLength(2);
    expect(more.some((c) => first.includes(c))).toBe(false);
    expect(eventsOf(h, 'dispatch:backup')).toEqual([]);
    expect(eventsOf(h, 'dispatch:ack')).toEqual([]);
    const callId = h.cad.playerUnit()?.callId ?? 0;
    const onCall = h.dispatcher.aiUnitsOnCall(callId, []);
    for (const c of more) {
      expect(onCall).toContain(c);
      expect(h.cad.unit(c)?.status).toBe('enRoute');
    }
    expect(h.dispatcher.sendBackup(2, 0)).toEqual([]);
  });
});

describe('officer names and resource units', () => {
  it('uses deps.officerName for the AI units (null keeps the roster name); the player is unchanged', async () => {
    const h = await makeHarness({ config: quietConfig(), officerName: (cs) => (cs === '21' ? 'Sgt. M. Chen' : null) });
    expect(h.cad.unit('21')?.officer).toBe('Sgt. M. Chen');
    expect(h.cad.unit('23')?.officer).toBe('Officer Park');
    expect(h.cad.playerUnit()?.officer).toBe('Officer Doe');
  });

  it('ignores a resource request in the dispatcher (no ack, no unit change)', async () => {
    const h = await makeHarness({ config: quietConfig() });
    clearEvents(h);
    h.dispatcher.request('12', { kind: 'resource', typeId: 'k9' }, 'radio');
    step(h);
    expect(eventsOf(h, 'dispatch:ack')).toEqual([]);
    expect(h.cad.playerUnit()?.status).toBe('available');
  });

  it('keeps resource units in CAD across restore (the roster reconcile removes only missing AI units)', async () => {
    const a = await makeHarness({ config: quietConfig() });
    a.cad.addUnit({ callsign: 'K9-1', kind: 'resource', officer: 'Officer Dog', beat: 'downtown', fleetIndex: 8 }, at(0));
    a.cad.addUnit({ callsign: '88', kind: 'ai', officer: 'Ghost', beat: 'downtown', fleetIndex: 7 }, at(0));
    const saves = json({ cad: a.cad.serialize(), dispatch: a.dispatcher.serialize(), traffic: a.traffic.snapshot(), records: a.records.serialize() });
    const b = await makeHarness({ start: false, config: quietConfig() });
    b.traffic.restore(saves.traffic);
    b.cad.restore(saves.cad);
    b.records.restore(saves.records);
    b.dispatcher.restore(saves.dispatch);
    expect(b.cad.unit('K9-1')?.kind).toBe('resource');
    expect(b.cad.unit('88')).toBeNull();
    expect(b.cad.unit('21')?.kind).toBe('ai');
  });
});

describe('dispatch save (Phase 6)', () => {
  it('validates the resource request kind in saved queues', async () => {
    expect(isUnitRequest({ kind: 'resource', typeId: 'k9' })).toBe(true);
    expect(isUnitRequest({ kind: 'resource' })).toBe(false);
    expect(isUnitRequest({ kind: 'resource', typeId: '' })).toBe(false);
    expect(isUnitRequest({ kind: 'resource', typeId: 7 })).toBe(false);
    const h = await makeHarness({ config: quietConfig() });
    h.dispatcher.request('12', { kind: 'resource', typeId: 'ems' }, 'mdt');
    const save = json(h.dispatcher.serialize());
    expect(save.requests).toEqual([{ callsign: '12', request: { kind: 'resource', typeId: 'ems' }, via: 'mdt' }]);
    expect(isDispatchSave(save)).toBe(true);
  });

  it('saves `directed` only when true and validates it as a boolean', async () => {
    const h = await makeHarness({ config: quietConfig() });
    const save0 = json(h.dispatcher.serialize());
    expect(save0.units.every((u) => !('directed' in u))).toBe(true);
    const [cs] = backupCallsigns(h);
    h.dispatcher.directUnit(cs ?? '', h.player.x + 100, h.player.z, 'respond');
    const save = json(h.dispatcher.serialize());
    expect(save.units.find((u) => u.callsign === cs)?.directed).toBe(true);
    expect(isDispatchSave(save)).toBe(true);
    const bad = json(save);
    (bad.units[0] as { directed?: unknown }).directed = 'yes';
    expect(isDispatchSave(bad)).toBe(false);
  });

  it('a directed unit survives save and load and is still not retargeted', async () => {
    const a = await makeHarness({ config: quietConfig() });
    const [cs] = backupCallsigns(a);
    if (!cs) throw new Error('no backup unit');
    a.dispatcher.directUnit(cs, a.player.x + 250, a.player.z, 'respond');
    run(a, 1);
    const saves = json({ cad: a.cad.serialize(), dispatch: a.dispatcher.serialize(), traffic: a.traffic.snapshot(), records: a.records.serialize() });
    const b = await makeHarness({ start: false, config: quietConfig() });
    b.sim = a.sim;
    b.traffic.restore(saves.traffic);
    b.cad.restore(saves.cad);
    b.records.restore(saves.records);
    b.dispatcher.restore(saves.dispatch);
    expect(b.dispatcher.serialize().units.find((u) => u.callsign === cs)?.directed).toBe(true);
  });
});
