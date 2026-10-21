import { describe, expect, it } from 'vitest';
import { MAX_CLOSED_CALLS, STATUS_TRANSITIONS, canAssign, canTransition, callNumber, isCadSave } from '../../src/cad/cadState';
import { DISPOSITIONS, dispositionLabel } from '../../src/cad/data';
import { REQUEST_VIAS, UNIT_STATUSES, type UnitStatus } from '../../src/cad/types';
import { addRoster, at, newCall, recordingCad, type Recorded } from './helpers';

/**
 * CAD state machine (Phase 9 §10): the unit status table written out, every (from, to) pair through the CadState API,
 * the call lifecycle with every disposition, `canAssign`, the closed-call cap and id monotonicity.
 */

/** The allowed transitions, copied from `cadState.ts` so that a change of the table shows in this diff. */
const ALLOWED: Readonly<Record<UnitStatus, readonly UnitStatus[]>> = {
  available: ['enRoute', 'onScene', 'busy', 'outOfService'],
  enRoute: ['onScene', 'available', 'busy'],
  onScene: ['busy', 'transporting', 'available', 'enRoute'],
  busy: ['available', 'onScene', 'enRoute', 'transporting'],
  transporting: ['available', 'onScene', 'busy'],
  outOfService: ['available'],
};

/** Statuses a unit may be assigned to a call from (assignment puts it en route). */
const ASSIGNABLE: Readonly<Record<UnitStatus, boolean>> = {
  available: true, enRoute: true, onScene: true, busy: true, transporting: false, outOfService: false,
};

/** Steps from a fresh (available) unit to each status, every step allowed by the table. */
const PATH: Readonly<Record<UnitStatus, readonly UnitStatus[]>> = {
  available: [], enRoute: ['enRoute'], onScene: ['onScene'], busy: ['busy'], transporting: ['onScene', 'transporting'], outOfService: ['outOfService'],
};

function statusEvents(events: readonly Recorded[]): Recorded[] {
  return events.filter((e) => e.topic === 'cad:unitStatus');
}

describe('unit status table', () => {
  it('is the table written out in this test', () => {
    expect(STATUS_TRANSITIONS).toEqual(ALLOWED);
    expect(Object.keys(STATUS_TRANSITIONS).sort()).toEqual([...UNIT_STATUSES].sort());
    for (const from of UNIT_STATUSES) {
      for (const to of UNIT_STATUSES) expect(canTransition(from, to), `${from} -> ${to}`).toBe(ALLOWED[from].includes(to));
    }
  });

  it('never allows a status to follow itself and always allows a way back to available', () => {
    for (const from of UNIT_STATUSES) {
      expect(ALLOWED[from]).not.toContain(from);
      if (from !== 'available') expect(ALLOWED[from], from).toContain('available');
    }
  });

  it('only lets an out-of-service unit return to available', () => {
    expect(ALLOWED.outOfService).toEqual(['available']);
    for (const from of UNIT_STATUSES) if (from !== 'outOfService' && from !== 'onScene' && from !== 'busy') expect(canTransition(from, 'transporting')).toBe(false);
  });

  describe.each(UNIT_STATUSES.map((s) => [s] as const))('from %s', (from) => {
    it.each(UNIT_STATUSES.map((s) => [s] as const))('to %s through setUnitStatus', (to) => {
      const { cad, events } = recordingCad();
      addRoster(cad);
      for (const step of PATH[from]) expect(cad.setUnitStatus('12', step, at(1), 'mdt'), `reach ${from}`).toBe(true);
      expect(cad.unit('12')?.status).toBe(from);
      const before = cad.revision;
      events.length = 0;

      const ok = cad.setUnitStatus('12', to, at(2), 'radio');
      const allowed = from === to || ALLOWED[from].includes(to);
      expect(ok).toBe(allowed);
      expect(cad.unit('12')?.status).toBe(allowed ? to : from);
      if (from === to) {
        expect(events).toEqual([]);
        expect(cad.revision).toBe(before);
      } else if (allowed) {
        expect(events).toEqual([{ topic: 'cad:unitStatus', payload: { callsign: '12', status: to, prev: from, callId: null, via: 'radio' } }]);
        expect(cad.unit('12')?.statusSince).toEqual(at(2));
      } else {
        expect(events).toEqual([]);
        expect(cad.unit('12')?.statusSince).toEqual(from === 'available' ? at(0) : at(1));
      }
      // The other units never move.
      expect(cad.unit('21')?.status).toBe('available');
      expect(cad.unit('23')?.status).toBe('available');
    });
  });

  it('refuses unknown units and unknown statuses without an event', () => {
    const { cad, events } = recordingCad();
    addRoster(cad);
    expect(cad.setUnitStatus('99', 'busy', at(1), 'mdt')).toBe(false);
    expect(cad.setUnitStatus('12', 'flying' as UnitStatus, at(1), 'mdt')).toBe(false);
    expect(cad.unit('12')?.status).toBe('available');
    expect(events).toEqual([]);
  });

  it('reports every via of REQUEST_VIAS on the status event', () => {
    for (const via of REQUEST_VIAS) {
      const { cad, events } = recordingCad();
      addRoster(cad);
      expect(cad.setUnitStatus('21', 'busy', at(1), via)).toBe(true);
      expect(statusEvents(events)).toEqual([{ topic: 'cad:unitStatus', payload: { callsign: '21', status: 'busy', prev: 'available', callId: null, via } }]);
    }
  });

  it('keeps a unit on its call across statuses that are not available or out of service, and takes it off for those', () => {
    for (const to of UNIT_STATUSES) {
      const { cad } = recordingCad();
      addRoster(cad);
      const call = cad.createCall(newCall(), at(1));
      expect(cad.assign(call.id, '21', at(2), 'dispatch')).toBe(true);
      const ok = cad.setUnitStatus('21', to, at(3), 'mdt');
      const unit = cad.unit('21');
      if (!ok) {
        expect(unit).toMatchObject({ status: 'enRoute', callId: call.id });
        continue;
      }
      if (to === 'available' || to === 'outOfService') {
        expect(unit?.callId).toBeNull();
        expect(cad.call(call.id)).toMatchObject({ status: 'pending', units: [], primary: null });
      } else {
        expect(unit?.callId).toBe(call.id);
        expect(cad.call(call.id)?.units).toEqual(['21']);
      }
    }
  });

  it('records the first arrival when a unit goes on scene and a transport line in the narrative', () => {
    const { cad } = recordingCad();
    addRoster(cad);
    const call = cad.createCall(newCall(), at(1));
    cad.assign(call.id, '21', at(2), 'dispatch');
    cad.setUnitStatus('21', 'onScene', at(10), 'radio');
    cad.assign(call.id, '23', at(11), 'backup');
    cad.setUnitStatus('23', 'onScene', at(20), 'radio');
    expect(cad.call(call.id)?.firstOnScene).toEqual(at(10));
    cad.setUnitStatus('21', 'transporting', at(30), 'radio');
    const texts = cad.call(call.id)?.narrative.map((n) => n.text) ?? [];
    expect(texts).toEqual(expect.arrayContaining(['21 on scene', '23 on scene', '21 transporting']));
  });
});

describe('canAssign', () => {
  it.each(UNIT_STATUSES.map((s) => [s] as const))('answers for the %s status', (status) => {
    expect(canAssign(status)).toBe(ASSIGNABLE[status]);
    expect(canAssign(status)).toBe(status === 'enRoute' || ALLOWED[status].includes('enRoute'));
  });

  it.each(UNIT_STATUSES.map((s) => [s] as const))('matches what assign does with a %s unit', (status) => {
    const { cad, events } = recordingCad();
    addRoster(cad);
    for (const step of PATH[status]) cad.setUnitStatus('21', step, at(1), 'mdt');
    const call = cad.createCall(newCall(), at(2));
    events.length = 0;
    const ok = cad.assign(call.id, '21', at(3), 'dispatch');
    expect(ok).toBe(canAssign(status));
    if (ok) {
      expect(cad.unit('21')).toMatchObject({ status: 'enRoute', callId: call.id });
      expect(cad.call(call.id)).toMatchObject({ status: 'active', units: ['21'], primary: '21' });
      expect(events.map((e) => e.topic)).toEqual(status === 'enRoute' ? ['cad:unitAssigned'] : ['cad:unitStatus', 'cad:unitAssigned']);
    } else {
      expect(cad.unit('21')).toMatchObject({ status, callId: null });
      expect(cad.call(call.id)).toMatchObject({ status: 'pending', units: [], primary: null, dispatched: null });
      expect(events).toEqual([]);
    }
  });

  it('refuses a closed call, an unknown call and an unknown unit', () => {
    const { cad, events } = recordingCad();
    addRoster(cad);
    const call = cad.createCall(newCall(), at(1));
    cad.closeCall(call.id, 'handled', at(2));
    events.length = 0;
    expect(cad.assign(call.id, '21', at(3), 'dispatch')).toBe(false);
    expect(cad.assign(999, '21', at(3), 'dispatch')).toBe(false);
    const open = cad.createCall(newCall(), at(3));
    expect(cad.assign(open.id, '77', at(4), 'dispatch')).toBe(false);
    expect(cad.unit('21')).toMatchObject({ status: 'available', callId: null });
    expect(cad.call(call.id)?.units).toEqual([]);
    expect(events.filter((e) => e.topic !== 'cad:callCreated')).toEqual([]);
  });

  it('accepts a double assignment of a unit to the same call without a change', () => {
    const { cad, events } = recordingCad();
    addRoster(cad);
    const call = cad.createCall(newCall(), at(1));
    expect(cad.assign(call.id, '21', at(2), 'dispatch')).toBe(true);
    events.length = 0;
    const rev = cad.revision;
    expect(cad.assign(call.id, '21', at(3), 'self')).toBe(true);
    expect(cad.call(call.id)?.units).toEqual(['21']);
    expect(events).toEqual([]);
    expect(cad.revision).toBe(rev);
  });

  it('moves a unit from its first call to a second one and returns the first to pending', () => {
    const { cad } = recordingCad();
    addRoster(cad);
    const a = cad.createCall(newCall(), at(1));
    const b = cad.createCall(newCall('alarm', 2), at(1));
    cad.assign(a.id, '21', at(2), 'dispatch');
    cad.assign(a.id, '23', at(2), 'backup');
    cad.assign(b.id, '21', at(3), 'self');
    expect(cad.unit('21')?.callId).toBe(b.id);
    expect(cad.call(a.id)).toMatchObject({ status: 'active', units: ['23'], primary: '23' });
    expect(cad.call(b.id)).toMatchObject({ status: 'active', units: ['21'], primary: '21' });
    cad.assign(b.id, '23', at(4), 'self');
    expect(cad.call(a.id)).toMatchObject({ status: 'pending', units: [], primary: null });
    expect(cad.call(b.id)?.units).toEqual(['21', '23']);
    expect(cad.call(b.id)?.primary).toBe('21');
  });

  it('keeps the dispatched time of the first assignment and clears a matching offer', () => {
    const { cad } = recordingCad();
    addRoster(cad);
    const call = cad.createCall(newCall(), at(1));
    cad.offer(call.id, '21', 30, at(2));
    expect(cad.call(call.id)).toMatchObject({ offeredTo: '21', offerExpires: 30 });
    cad.assign(call.id, '21', at(3), 'dispatch');
    expect(cad.call(call.id)).toMatchObject({ offeredTo: null, offerExpires: 0, dispatched: at(3) });
    cad.assign(call.id, '23', at(9), 'backup');
    expect(cad.call(call.id)?.dispatched).toEqual(at(3));
  });

  it('puts the unit off its call when it is unassigned, unless it is out of service', () => {
    const { cad } = recordingCad();
    addRoster(cad);
    const call = cad.createCall(newCall(), at(1));
    cad.assign(call.id, '21', at(2), 'dispatch');
    cad.setUnitStatus('21', 'onScene', at(3), 'radio');
    cad.unassign('21', at(4));
    expect(cad.unit('21')).toMatchObject({ status: 'available', callId: null });
    expect(cad.call(call.id)?.status).toBe('pending');
    cad.unassign('21', at(5));
    cad.unassign('99', at(5));
    expect(cad.unit('21')?.status).toBe('available');
  });
});

describe('call lifecycle', () => {
  it('has a disposition table that the lifecycle covers entirely', () => {
    expect(DISPOSITIONS.length).toBeGreaterThanOrEqual(11);
    expect(new Set(DISPOSITIONS.map((d) => d.id)).size).toBe(DISPOSITIONS.length);
  });

  it.each(DISPOSITIONS.map((d) => [d.id, d.label] as const))('runs create -> assign -> enRoute -> onScene -> close with %s (%s)', (id) => {
    const { cad, events } = recordingCad();
    addRoster(cad);

    const call = cad.createCall(newCall('trafficHazard', 3), at(1));
    expect(call).toMatchObject({ id: 1, number: 'C-00001', status: 'pending', units: [], primary: null, closed: null, disposition: null });

    expect(cad.assign(call.id, '21', at(2), 'dispatch')).toBe(true);
    expect(cad.call(call.id)).toMatchObject({ status: 'active', units: ['21'], primary: '21', dispatched: at(2), firstOnScene: null });
    expect(cad.unit('21')).toMatchObject({ status: 'enRoute', callId: call.id });

    expect(cad.setUnitStatus('21', 'onScene', at(10), 'radio')).toBe(true);
    expect(cad.call(call.id)?.firstOnScene).toEqual(at(10));

    cad.closeCall(call.id, id, at(40));
    const closed = cad.call(call.id);
    expect(closed).toMatchObject({ status: 'closed', closed: at(40), disposition: id, offeredTo: null, units: ['21'] });
    expect(closed?.narrative.map((n) => n.text)).toEqual([
      'RP reports debris.', '21 dispatched', '21 on scene', `Closed: ${dispositionLabel(id)}`,
    ]);
    expect(cad.unit('21')).toMatchObject({ status: 'available', callId: null });
    expect(cad.openCalls()).toEqual([]);

    expect(events.map((e) => e.topic)).toEqual([
      'cad:callCreated', 'cad:unitStatus', 'cad:unitAssigned', 'cad:unitStatus', 'cad:unitStatus', 'cad:callClosed',
    ]);
    expect(events[events.length - 1]).toEqual({ topic: 'cad:callClosed', payload: { callId: 1, disposition: id } });
    expect(statusEvents(events).map((e) => (e.payload as { status: string }).status)).toEqual(['enRoute', 'onScene', 'available']);
  });

  it('closes a call with several units and releases every one of them', () => {
    const { cad } = recordingCad();
    addRoster(cad);
    const call = cad.createCall(newCall(), at(1));
    cad.assign(call.id, '12', at(2), 'self');
    cad.assign(call.id, '21', at(2), 'backup');
    cad.assign(call.id, '23', at(2), 'backup');
    // En route -> out of service is not in the table, so the unit stays on the call.
    expect(cad.setUnitStatus('23', 'outOfService', at(3), 'mdt')).toBe(false);
    cad.setUnitStatus('12', 'onScene', at(3), 'mdt');
    cad.setUnitStatus('12', 'transporting', at(4), 'mdt');
    cad.closeCall(call.id, 'transported', at(5));
    expect(cad.units().map((u) => [u.callsign, u.status, u.callId])).toEqual([['12', 'available', null], ['21', 'available', null], ['23', 'available', null]]);
    expect(cad.call(call.id)?.units).toEqual(['12', '21', '23']);
  });

  it('never leaves a unit out of service on a call (the status detaches it)', () => {
    const { cad } = recordingCad();
    addRoster(cad);
    const call = cad.createCall(newCall(), at(1));
    cad.assign(call.id, '21', at(2), 'dispatch');
    expect(cad.setUnitStatus('21', 'available', at(3), 'mdt')).toBe(true);
    expect(cad.setUnitStatus('21', 'outOfService', at(4), 'mdt')).toBe(true);
    expect(cad.assign(call.id, '21', at(5), 'dispatch')).toBe(false);
    cad.closeCall(call.id, 'handled', at(6));
    expect(cad.unit('21')).toMatchObject({ status: 'outOfService', callId: null });
  });

  it('ignores a second close, a close of an unknown call and changes to a closed call', () => {
    const { cad, events } = recordingCad();
    addRoster(cad);
    const call = cad.createCall(newCall(), at(1));
    cad.closeCall(call.id, 'handled', at(2));
    events.length = 0;
    const snapshot = structuredClone(cad.serialize());
    cad.closeCall(call.id, 'cancelled', at(3));
    cad.closeCall(404, 'handled', at(3));
    cad.setPriority(call.id, 1, at(3));
    cad.offer(call.id, '21', 99, at(3));
    cad.updateLocation(call.id, { ...call.location, text: 'Elsewhere' }, at(3));
    expect(events).toEqual([]);
    expect(cad.serialize()).toEqual(snapshot);
    expect(cad.call(call.id)?.disposition).toBe('handled');
  });

  it('numbers calls C-00001 up and formats ids past 99999', () => {
    expect(callNumber(1)).toBe('C-00001');
    expect(callNumber(42)).toBe('C-00042');
    expect(callNumber(99999)).toBe('C-99999');
    expect(callNumber(123456)).toBe('C-123456');
  });
});

describe('closed-call cap and ids', () => {
  it('keeps every open call and the newest MAX_CLOSED_CALLS closed ones', () => {
    expect(MAX_CLOSED_CALLS).toBe(200);
    const { cad } = recordingCad();
    addRoster(cad);
    const open = cad.createCall(newCall('alarm', 1), at(0));
    const ids: number[] = [];
    for (let i = 0; i < MAX_CLOSED_CALLS + 50; i++) {
      const c = cad.createCall(newCall(), at(1 + i));
      ids.push(c.id);
      cad.closeCall(c.id, 'handled', at(1 + i));
      const closed = cad.calls().filter((x) => x.status === 'closed').length;
      expect(closed).toBe(Math.min(i + 1, MAX_CLOSED_CALLS));
    }
    expect(cad.calls()).toHaveLength(MAX_CLOSED_CALLS + 1);
    expect(cad.call(open.id)).not.toBeNull();
    for (const id of ids.slice(0, 50)) expect(cad.call(id), `call ${id}`).toBeNull();
    for (const id of ids.slice(50)) expect(cad.call(id), `call ${id}`).not.toBeNull();
    expect(cad.serialize().calls).toHaveLength(MAX_CLOSED_CALLS + 1);
  });

  it('drops the call that was closed first, not the one that was created first', () => {
    const { cad } = recordingCad();
    const calls = Array.from({ length: MAX_CLOSED_CALLS + 1 }, (_, i) => cad.createCall(newCall(), at(i)));
    // Close in reverse: call 201 is the oldest closure and must be the one that goes.
    calls.slice().reverse().forEach((c, i) => cad.closeCall(c.id, 'handled', at(1000 + i)));
    expect(cad.calls()).toHaveLength(MAX_CLOSED_CALLS);
    expect(cad.call(calls[calls.length - 1]?.id ?? 0)).toBeNull();
    expect(cad.call(calls[0]?.id ?? 0)).not.toBeNull();
  });

  it('breaks a tie of close times by the lower id', () => {
    const { cad } = recordingCad();
    const calls = Array.from({ length: MAX_CLOSED_CALLS + 1 }, () => cad.createCall(newCall(), at(0)));
    for (const c of calls) cad.closeCall(c.id, 'handled', at(5));
    expect(cad.call(calls[0]?.id ?? 0)).toBeNull();
    expect(cad.call(calls[1]?.id ?? 0)).not.toBeNull();
  });

  it('hands out strictly increasing ids, also after calls were dropped and after a restore', () => {
    const { cad } = recordingCad();
    let last = 0;
    for (let i = 0; i < MAX_CLOSED_CALLS + 20; i++) {
      const c = cad.createCall(newCall(), at(i));
      expect(c.id).toBe(last + 1);
      last = c.id;
      cad.closeCall(c.id, 'handled', at(i));
    }
    expect(cad.call(1)).toBeNull();
    const save = cad.serialize();
    expect(save.nextCallId).toBe(last + 1);
    const { cad: other } = recordingCad();
    other.restore(save);
    expect(other.createCall(newCall(), at(999)).id).toBe(last + 1);
    // A save whose counter fell behind its calls still never reuses an id.
    const stale = { ...save, nextCallId: 2 };
    const { cad: third } = recordingCad();
    third.restore(stale);
    expect(third.createCall(newCall(), at(999)).id).toBe(last + 1);
  });

  it('keeps ids unique across the numbers of the calls kept', () => {
    const { cad } = recordingCad();
    for (let i = 0; i < 30; i++) cad.createCall(newCall(), at(i));
    const numbers = cad.calls().map((c) => c.number);
    expect(new Set(numbers).size).toBe(30);
    expect(numbers).toEqual(cad.calls().map((c) => callNumber(c.id)));
    expect(isCadSave(cad.serialize())).toBe(true);
  });
});
