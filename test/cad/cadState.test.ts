import { describe, expect, it } from 'vitest';
import { CadState, MAX_CLOSED_CALLS, STATUS_TRANSITIONS, callNumber, canTransition } from '../../src/cad/cadState';
import { UNIT_STATUSES, type TrafficStopInfo, type UnitStatus } from '../../src/cad/types';
import { addRoster, at, newCall, recordingCad } from './helpers';

describe('CadState calls and units', () => {
  it('creates calls with ids from 1, numbers and a CAD narrative line', () => {
    const { cad, events } = recordingCad();
    const a = cad.createCall(newCall(), at(10));
    const b = cad.createCall({ ...newCall('trafficStop', 4, 'Stop.'), selfInitiated: true, vehicles: [5] }, at(11));
    expect(a.id).toBe(1);
    expect(a.number).toBe('C-00001');
    expect(b.number).toBe('C-00002');
    expect(callNumber(12345)).toBe('C-12345');
    expect(a.nature).toBe('Traffic hazard');
    expect(a.status).toBe('pending');
    expect(a.narrative).toEqual([{ sim: 10, game: at(10).game, source: 'CAD', text: 'RP reports debris.' }]);
    expect(b.selfInitiated).toBe(true);
    expect(b.vehicles).toEqual([5]);
    expect(events).toEqual([
      { topic: 'cad:callCreated', payload: { callId: 1, typeId: 'trafficHazard', priority: 3, selfInitiated: false } },
      { topic: 'cad:callCreated', payload: { callId: 2, typeId: 'trafficStop', priority: 4, selfInitiated: true } },
    ]);
    expect(cad.call(1)).toBe(a);
    expect(cad.call(99)).toBeNull();
    expect(cad.calls()).toEqual([a, b]);
    expect(cad.createCall(newCall('mysteryType'), at(12)).nature).toBe('mysteryType');
  });

  it('runs a call through create -> assign -> on scene -> close with events in order', () => {
    const { cad, events } = recordingCad();
    addRoster(cad);
    const call = cad.createCall(newCall(), at(10));
    events.length = 0;

    cad.assign(call.id, '21', at(20), 'dispatch');
    expect(call.status).toBe('active');
    expect(call.units).toEqual(['21']);
    expect(call.primary).toBe('21');
    expect(call.dispatched).toEqual(at(20));
    const u21 = cad.unit('21');
    expect(u21?.status).toBe('enRoute');
    expect(u21?.callId).toBe(call.id);
    expect(u21?.statusSince).toEqual(at(20));

    expect(cad.setUnitStatus('21', 'onScene', at(60), 'auto')).toBe(true);
    expect(call.firstOnScene).toEqual(at(60));
    cad.assign(call.id, '23', at(70), 'backup');
    expect(cad.setUnitStatus('23', 'onScene', at(80), 'radio')).toBe(true);
    expect(call.firstOnScene).toEqual(at(60));
    expect(call.units).toEqual(['21', '23']);
    expect(call.primary).toBe('21');

    cad.closeCall(call.id, 'handled', at(200));
    expect(call.status).toBe('closed');
    expect(call.closed).toEqual(at(200));
    expect(call.disposition).toBe('handled');
    expect(cad.unit('21')?.status).toBe('available');
    expect(cad.unit('21')?.callId).toBeNull();
    expect(cad.unit('23')?.status).toBe('available');
    expect(cad.openCalls()).toEqual([]);

    expect(events).toEqual([
      { topic: 'cad:unitStatus', payload: { callsign: '21', status: 'enRoute', prev: 'available', callId: 1, via: 'auto' } },
      { topic: 'cad:unitAssigned', payload: { callId: 1, callsign: '21', by: 'dispatch' } },
      { topic: 'cad:unitStatus', payload: { callsign: '21', status: 'onScene', prev: 'enRoute', callId: 1, via: 'auto' } },
      { topic: 'cad:unitStatus', payload: { callsign: '23', status: 'enRoute', prev: 'available', callId: 1, via: 'auto' } },
      { topic: 'cad:unitAssigned', payload: { callId: 1, callsign: '23', by: 'backup' } },
      { topic: 'cad:unitStatus', payload: { callsign: '23', status: 'onScene', prev: 'enRoute', callId: 1, via: 'radio' } },
      { topic: 'cad:unitStatus', payload: { callsign: '21', status: 'available', prev: 'onScene', callId: null, via: 'auto' } },
      { topic: 'cad:unitStatus', payload: { callsign: '23', status: 'available', prev: 'onScene', callId: null, via: 'auto' } },
      { topic: 'cad:callClosed', payload: { callId: 1, disposition: 'handled' } },
    ]);

    // Closed calls ignore further assignment and closing.
    events.length = 0;
    cad.assign(call.id, '21', at(210), 'dispatch');
    cad.closeCall(call.id, 'unfounded', at(210));
    expect(events).toEqual([]);
    expect(call.disposition).toBe('handled');
  });

  it('enforces the status transition table', () => {
    const allowed: [UnitStatus, UnitStatus][] = [
      ['available', 'enRoute'], ['available', 'onScene'], ['available', 'busy'], ['available', 'outOfService'],
      ['enRoute', 'onScene'], ['enRoute', 'available'], ['enRoute', 'busy'],
      ['onScene', 'busy'], ['onScene', 'transporting'], ['onScene', 'available'], ['onScene', 'enRoute'],
      ['busy', 'available'], ['busy', 'onScene'], ['busy', 'enRoute'], ['busy', 'transporting'],
      ['transporting', 'available'], ['transporting', 'onScene'], ['transporting', 'busy'],
      ['outOfService', 'available'],
    ];
    const key = (a: UnitStatus, b: UnitStatus): string => `${a}>${b}`;
    const allowedSet = new Set(allowed.map(([a, b]) => key(a, b)));
    for (const from of UNIT_STATUSES) {
      for (const to of UNIT_STATUSES) {
        if (from === to) continue;
        expect(canTransition(from, to)).toBe(allowedSet.has(key(from, to)));
      }
    }
    expect(Object.values(STATUS_TRANSITIONS).flat()).toHaveLength(allowed.length);

    // Reach each source status through allowed steps, then try every target.
    const paths: Record<UnitStatus, UnitStatus[]> = {
      available: [], enRoute: ['enRoute'], onScene: ['onScene'], busy: ['busy'],
      transporting: ['onScene', 'transporting'], outOfService: ['outOfService'],
    };
    for (const from of UNIT_STATUSES) {
      for (const to of UNIT_STATUSES) {
        if (from === to) continue;
        const { cad, events } = recordingCad();
        addRoster(cad);
        for (const step of paths[from]) expect(cad.setUnitStatus('12', step, at(1), 'mdt')).toBe(true);
        expect(cad.unit('12')?.status).toBe(from);
        events.length = 0;
        const ok = cad.setUnitStatus('12', to, at(2), 'mdt');
        expect(ok).toBe(allowedSet.has(key(from, to)));
        expect(cad.unit('12')?.status).toBe(ok ? to : from);
        expect(events).toEqual(
          ok ? [{ topic: 'cad:unitStatus', payload: { callsign: '12', status: to, prev: from, callId: null, via: 'mdt' } }] : [],
        );
      }
    }
  });

  it('refuses unknown units and accepts a repeated status silently', () => {
    const { cad, events } = recordingCad();
    addRoster(cad);
    expect(cad.setUnitStatus('99', 'busy', at(1), 'mdt')).toBe(false);
    expect(cad.setUnitStatus('12', 'available', at(1), 'mdt')).toBe(true);
    expect(cad.setUnitStatus('12', 'bogus' as UnitStatus, at(1), 'mdt')).toBe(false);
    expect(events).toEqual([]);
    cad.assign(99, '12', at(1), 'self');
    cad.assign(1, '99', at(1), 'self');
    cad.unassign('99', at(1));
    cad.closeCall(42, 'handled', at(1));
    cad.addNarrative(42, 'x', 'y', at(1));
    cad.setPriority(42, 1, at(1));
    cad.offer(42, '12', 5, at(1));
    cad.setUnitPosition('99', 1, 2);
    cad.setEmergency('99', true, at(1));
    expect(events).toEqual([]);
  });

  it('returns a call left without units to pending', () => {
    const { cad, events } = recordingCad();
    addRoster(cad);
    const a = cad.createCall(newCall(), at(1));
    const b = cad.createCall(newCall('alarm', 2), at(2));
    cad.assign(a.id, '21', at(3), 'dispatch');
    cad.assign(a.id, '23', at(3), 'dispatch');
    events.length = 0;
    cad.unassign('21', at(4));
    expect(a.units).toEqual(['23']);
    expect(a.primary).toBe('23');
    expect(a.status).toBe('active');
    expect(cad.unit('21')?.status).toBe('available');
    expect(events[0]).toEqual({ topic: 'cad:callUpdated', payload: { callId: a.id, change: 'units' } });
    expect(events[1]).toEqual({ topic: 'cad:unitStatus', payload: { callsign: '21', status: 'available', prev: 'enRoute', callId: null, via: 'auto' } });

    // Reassigning the last unit elsewhere leaves the first call pending.
    cad.assign(b.id, '23', at(5), 'backup');
    expect(a.units).toEqual([]);
    expect(a.primary).toBeNull();
    expect(a.status).toBe('pending');
    expect(b.status).toBe('active');
    expect(cad.unit('23')?.callId).toBe(b.id);

    // Going 10-8 or 10-7 also takes a unit off its call.
    cad.setUnitStatus('23', 'onScene', at(6), 'radio');
    expect(cad.setUnitStatus('23', 'available', at(7), 'radio')).toBe(true);
    expect(b.status).toBe('pending');
    expect(cad.unit('23')?.callId).toBeNull();
    expect(b.firstOnScene).toEqual(at(6));
  });

  it('sorts open calls P1 first, then oldest', () => {
    const { cad } = recordingCad();
    const c1 = cad.createCall(newCall('noiseComplaint', 4), at(1));
    const c2 = cad.createCall(newCall('alarm', 2), at(2));
    const c3 = cad.createCall(newCall('trafficHazard', 2), at(3));
    const c4 = cad.createCall(newCall('officerEmergency', 1), at(4));
    const c5 = cad.createCall(newCall('trafficHazard', 3), at(5));
    cad.closeCall(c5.id, 'handled', at(6));
    expect(cad.openCalls().map((c) => c.id)).toEqual([c4.id, c2.id, c3.id, c1.id]);
    cad.setPriority(c1.id, 1, at(7));
    expect(cad.openCalls().map((c) => c.id)).toEqual([c1.id, c4.id, c2.id, c3.id]);
  });

  it('records offers, narratives, priorities and emergencies', () => {
    const { cad, events } = recordingCad();
    addRoster(cad);
    const call = cad.createCall(newCall(), at(1));
    events.length = 0;
    cad.offer(call.id, '12', 26, at(1));
    expect(call.offeredTo).toBe('12');
    expect(call.offerExpires).toBe(26);
    cad.offer(call.id, null, 99, at(2));
    expect(call.offeredTo).toBeNull();
    expect(call.offerExpires).toBe(0);
    cad.offer(call.id, '12', 30, at(3));
    cad.assign(call.id, '12', at(4), 'self');
    expect(call.offeredTo).toBeNull();
    cad.addNarrative(call.id, '12', 'On scene, debris removed.', at(5));
    expect(call.narrative[1]).toEqual({ sim: 5, game: at(5).game, source: '12', text: 'On scene, debris removed.' });
    cad.setPriority(call.id, 2, at(6));
    expect(call.priority).toBe(2);
    cad.setPriority(call.id, 2, at(6));
    const updates = events.filter((e) => e.topic === 'cad:callUpdated').map((e) => (e.payload as { change: string }).change);
    expect(updates).toEqual(['offer', 'offer', 'offer', 'narrative', 'priority']);

    const rev = cad.revision;
    cad.setEmergency('12', true, at(7));
    expect(cad.unit('12')?.emergency).toBe(true);
    expect(cad.revision).toBe(rev + 1);
    cad.setEmergency('12', true, at(7));
    expect(cad.revision).toBe(rev + 1);
    expect(cad.playerUnit()?.callsign).toBe('12');
    expect(new CadState().playerUnit()).toBeNull();
  });

  it('keeps an existing unit on addUnit and lists units in order', () => {
    const { cad } = recordingCad();
    addRoster(cad);
    const again = cad.addUnit({ callsign: '21', kind: 'ai', officer: 'Someone Else', beat: 'x', fleetIndex: 9 }, at(5));
    expect(again.officer).toBe('Officer Reyes');
    expect(cad.units().map((u) => u.callsign)).toEqual(['12', '21', '23']);
  });

  it('moves a re-linked draft document from its old call to the new one (or to none)', () => {
    const { cad } = recordingCad();
    const a = cad.createCall(newCall(), at(0));
    const b = cad.createCall(newCall('alarm', 2), at(0));
    const report = cad.docs.create('report', { title: 'Debris', callId: a.id }, at(0), 'Officer Doe #4071');
    expect(a.documents).toEqual([report.id]);
    cad.docs.update(report.id, { callId: b.id }, at(1));
    expect(a.documents).toEqual([]);
    expect(b.documents).toEqual([report.id]);
    cad.docs.update(report.id, { callId: null }, at(2));
    expect(b.documents).toEqual([]);
  });

  it('refuses to assign a unit that may not go en route (out of service, transporting)', () => {
    const { cad } = recordingCad();
    addRoster(cad);
    const c = cad.createCall(newCall(), at(0));
    expect(cad.setUnitStatus('21', 'outOfService', at(1), 'mdt')).toBe(true);
    expect(cad.assign(c.id, '21', at(2), 'self')).toBe(false);
    expect(cad.unit('21')).toMatchObject({ status: 'outOfService', callId: null });
    expect(c.units).toEqual([]);
    expect(cad.assign(c.id, '23', at(3), 'dispatch')).toBe(true);
    expect(cad.unit('23')?.status).toBe('enRoute');
  });

  it('drops the oldest closed calls beyond MAX_CLOSED_CALLS but keeps documents', () => {
    const { cad } = recordingCad();
    addRoster(cad);
    const first = cad.createCall(newCall(), at(0));
    const report = cad.docs.create('report', { title: 'Debris', callId: first.id }, at(0), 'Officer Doe #4071');
    expect(first.documents).toEqual([report.id]);
    cad.closeCall(first.id, 'reportTaken', at(1));
    const open = cad.createCall(newCall('alarm', 2), at(1));
    for (let i = 0; i < MAX_CLOSED_CALLS + 5; i++) {
      const c = cad.createCall(newCall(), at(2 + i));
      cad.closeCall(c.id, 'handled', at(2 + i));
    }
    const closed = cad.calls().filter((c) => c.status === 'closed');
    expect(closed).toHaveLength(MAX_CLOSED_CALLS);
    expect(cad.call(first.id)).toBeNull();
    expect(cad.call(open.id)).toBe(open);
    expect(closed[0]?.id).toBe(open.id + 6);
    expect(cad.docs.get(report.id)).not.toBeNull();
    expect(cad.docs.byCall(first.id)).toHaveLength(1);
  });

  it('bumps revision on mutations and avlRevision on positions only', () => {
    const { cad } = recordingCad();
    addRoster(cad);
    const r0 = cad.revision;
    const a0 = cad.avlRevision;
    cad.setUnitPosition('21', 100, -50);
    cad.setUnitPosition('21', 101, -50);
    expect(cad.revision).toBe(r0);
    expect(cad.avlRevision).toBe(a0 + 2);
    expect(cad.unit('21')).toMatchObject({ x: 101, z: -50 });
    const call = cad.createCall(newCall(), at(1));
    expect(cad.revision).toBeGreaterThan(r0);
    let r = cad.revision;
    const steps: (() => void)[] = [
      () => cad.addNarrative(call.id, 'CAD', 'x', at(2)),
      () => cad.setPriority(call.id, 1, at(2)),
      () => cad.offer(call.id, '12', 9, at(2)),
      () => cad.assign(call.id, '21', at(2), 'dispatch'),
      () => cad.setUnitStatus('21', 'onScene', at(3), 'auto'),
      () => cad.unassign('21', at(4)),
      () => cad.closeCall(call.id, 'handled', at(5)),
      () => cad.docs.create('evidence', { description: 'Knife' }, at(6), 'Officer Doe'),
      () => cad.setTrafficStop(null, at(7)),
    ];
    for (const step of steps) {
      step();
      expect(cad.revision).toBeGreaterThan(r);
      r = cad.revision;
    }
    expect(cad.avlRevision).toBe(a0 + 2);
  });
});

describe('CadState traffic stop', () => {
  function stopInfo(): TrafficStopInfo {
    return {
      callId: 1, vehicleId: 4242, plate: 'ABC 1234', x: 10, z: 20, started: at(30), driverId: -1, trueDriverId: 777,
      plateRun: false, vinChecked: false, vinResult: '', citations: [], outcome: 'active',
    };
  }

  it('announces activation and the end of the stop', () => {
    const { cad, events } = recordingCad();
    const info = stopInfo();
    cad.setTrafficStop(info, at(30));
    expect(cad.trafficStop).toEqual(info);
    expect(cad.trafficStop).not.toBe(info);
    expect(events).toEqual([{ topic: 'cad:trafficStop', payload: { active: true, callId: 1, vehicleId: 4242 } }]);
    events.length = 0;

    cad.updateTrafficStop({ driverId: 777, plateRun: true, citations: ['CT-000001'] }, at(40));
    expect(cad.trafficStop).toMatchObject({ driverId: 777, plateRun: true, citations: ['CT-000001'] });
    expect(events).toEqual([]);
    cad.updateTrafficStop({ vehicleId: 1, plate: 'ZZZ', trueDriverId: 1 }, at(41));
    expect(cad.trafficStop).toMatchObject({ vehicleId: 4242, plate: 'ABC 1234', trueDriverId: 777 });

    cad.updateTrafficStop({ outcome: 'released' }, at(50));
    expect(events).toEqual([{ topic: 'cad:trafficStop', payload: { active: false, callId: 1, vehicleId: 4242 } }]);
    cad.updateTrafficStop({ outcome: 'arrest' }, at(51));
    expect(events).toHaveLength(1);
    cad.setTrafficStop(null, at(60));
    expect(cad.trafficStop).toBeNull();
    expect(events).toHaveLength(1);
  });

  it('ends an active stop when it is cleared', () => {
    const { cad, events } = recordingCad();
    cad.setTrafficStop(stopInfo(), at(30));
    cad.setTrafficStop(null, at(31));
    expect(events.map((e) => e.payload)).toEqual([
      { active: true, callId: 1, vehicleId: 4242 },
      { active: false, callId: 1, vehicleId: 4242 },
    ]);
    cad.updateTrafficStop({ outcome: 'lost' }, at(32));
    expect(events).toHaveLength(2);
  });
});
