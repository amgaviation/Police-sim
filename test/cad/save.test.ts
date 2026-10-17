import { describe, expect, it } from 'vitest';
import { CadState, emptyCadSave, isCadSave, type CadSave } from '../../src/cad/cadState';
import { addRoster, at, newCall, recordingCad } from './helpers';

const AUTHOR = 'Officer Doe #4071';

/** A CAD with calls in every state, units, every document kind and an active stop. */
function busyCad(): CadState {
  const { cad } = recordingCad();
  addRoster(cad);
  const a = cad.createCall(newCall(), at(1));
  const b = cad.createCall({ ...newCall('trafficStop', 4, 'Stop'), selfInitiated: true, persons: [3], vehicles: [9] }, at(2));
  cad.createCall(newCall('alarm', 2), at(3));
  cad.assign(a.id, '21', at(4), 'dispatch');
  cad.setUnitStatus('21', 'onScene', at(5), 'auto');
  cad.closeCall(a.id, 'handled', at(6));
  cad.assign(b.id, '12', at(7), 'self');
  cad.setUnitStatus('12', 'onScene', at(8), 'auto');
  cad.offer(3, '23', 40, at(9));
  cad.setUnitPosition('23', 123.5, -77.25);
  cad.setEmergency('23', true, at(9));
  cad.setUnitStatus('23', 'outOfService', at(9), 'mdt');
  const r = cad.docs.create('report', { callId: a.id, title: 'Debris', location: '248 N Oak Street', narrative: 'Removed a mattress from the roadway.', persons: [{ personId: 3, role: 'reportingParty' }], vehicles: [{ vehicleId: 9, plate: 'ABC 1234', role: 'involved' }] }, at(10), AUTHOR);
  cad.docs.finalize(r.id, at(11));
  const c = cad.docs.create('citation', { callId: b.id, personId: 3, vehicleId: 9, plate: 'ABC 1234', location: 'Oak Street at 2nd Street', violations: [{ statuteId: 'TR-301', fine: 150, detail: '52/35' }], recordedSpeedMph: 52, limitMph: 35 }, at(12), AUTHOR);
  cad.docs.finalize(c.id, at(13));
  cad.docs.create('booking', { personId: 3, charges: ['PC-220'] }, at(14), AUTHOR);
  cad.docs.create('evidence', { description: 'Knife', category: 'weapon', custody: [{ game: 1, action: 'collected', by: AUTHOR, note: '' }] }, at(15), AUTHOR);
  cad.docs.create('supplement', { parentId: r.id, narrative: 'Follow-up call made.' }, at(16), AUTHOR);
  cad.setTrafficStop({
    callId: b.id, vehicleId: 9, plate: 'ABC 1234', x: 1, z: 2, started: at(7), driverId: 3, trueDriverId: 3,
    plateRun: true, vinChecked: false, vinResult: '', citations: [c.id], outcome: 'active',
  }, at(17));
  return cad;
}

describe('CAD save', () => {
  it('round-trips through JSON', () => {
    const cad = busyCad();
    const save = cad.serialize();
    expect(isCadSave(save)).toBe(true);
    const json = JSON.parse(JSON.stringify(save)) as unknown;
    expect(json).toEqual(save);
    expect(isCadSave(json)).toBe(true);

    const restored = new CadState();
    const rev = restored.revision;
    restored.restore(json as CadSave);
    expect(restored.revision).toBeGreaterThan(rev);
    expect(restored.serialize()).toEqual(save);
    expect(restored.trafficStop?.citations).toEqual(['CT-000001']);
    expect(restored.openCalls().map((c) => c.id)).toEqual(cad.openCalls().map((c) => c.id));
    expect(restored.unit('23')).toMatchObject({ x: 123.5, z: -77.25, emergency: true, status: 'outOfService' });

    // Counters and call ids continue after a restore.
    expect(restored.createCall(newCall(), at(20)).id).toBe(4);
    expect(restored.docs.create('report', {}, at(20), AUTHOR).id).toBe('R-0002');
    expect(restored.docs.create('citation', {}, at(20), AUTHOR).id).toBe('CT-000002');

    // The restored state is independent of the save object.
    (json as CadSave).calls[0]?.narrative.push({ sim: 0, game: 0, source: 'x', text: 'y' });
    expect(restored.call(1)?.narrative).toHaveLength(1);
  });

  it('starts empty', () => {
    const save = emptyCadSave();
    expect(isCadSave(save)).toBe(true);
    const cad = new CadState();
    cad.restore(save);
    expect(cad.serialize()).toEqual(save);
    expect(new CadState().serialize()).toEqual(save);
  });

  it('rejects malformed saves', () => {
    const good = busyCad().serialize();
    const mutate = (fn: (s: Record<string, unknown> & CadSave) => void): unknown => {
      const s = JSON.parse(JSON.stringify(good)) as Record<string, unknown> & CadSave;
      fn(s);
      return s;
    };
    const bad: unknown[] = [
      null,
      [],
      mutate((s) => { (s as Record<string, unknown>).version = 2; }),
      mutate((s) => { s.nextCallId = 0; }),
      mutate((s) => { s.nextCallId = 2; }),
      mutate((s) => { delete (s as Record<string, unknown>).trafficStop; }),
      mutate((s) => { (s.calls[0] as unknown as Record<string, unknown>).priority = 5; }),
      mutate((s) => { (s.calls[0] as unknown as Record<string, unknown>).status = 'open'; }),
      mutate((s) => { (s.calls[0] as unknown as Record<string, unknown>).offerExpires = 'soon'; }),
      mutate((s) => { (s.calls[0] as unknown as { location: Record<string, unknown> }).location.x = null; }),
      mutate((s) => { (s.calls[0] as unknown as { caller: Record<string, unknown> }).caller.kind = 'ghost'; }),
      mutate((s) => { (s.calls[0] as unknown as Record<string, unknown>).created = { sim: 1 }; }),
      mutate((s) => { s.calls.push(JSON.parse(JSON.stringify(s.calls[0])) as never); }),
      mutate((s) => { (s.units[0] as unknown as Record<string, unknown>).status = 'lunch'; }),
      mutate((s) => { (s.units[0] as unknown as Record<string, unknown>).kind = 'drone'; }),
      mutate((s) => { (s.units[0] as unknown as Record<string, unknown>).callId = 0; }),
      mutate((s) => { s.units.push(JSON.parse(JSON.stringify(s.units[0])) as never); }),
      mutate((s) => { (s.docs.counters as Record<string, unknown>).report = -1; }),
      mutate((s) => { (s.docs.items[0] as unknown as Record<string, unknown>).kind = 'memo'; }),
      mutate((s) => { (s.docs.items[0] as unknown as Record<string, unknown>).status = 'locked'; }),
      mutate((s) => { (s.docs.items[1] as unknown as Record<string, unknown>).totalFine = Number.NaN; }),
      mutate((s) => { (s.docs.items[2] as unknown as Record<string, unknown>).charges = [1]; }),
      mutate((s) => { (s.docs.items[3] as unknown as { custody: Record<string, unknown>[] }).custody[0]!.action = 'stolen'; }),
      mutate((s) => { (s.docs.items[0] as unknown as { persons: Record<string, unknown>[] }).persons[0]!.role = 'boss'; }),
      mutate((s) => { s.docs.items.push(JSON.parse(JSON.stringify(s.docs.items[0])) as never); }),
      mutate((s) => { (s.trafficStop as unknown as Record<string, unknown>).outcome = 'escaped'; }),
      mutate((s) => { (s.trafficStop as unknown as Record<string, unknown>).x = Number.POSITIVE_INFINITY; }),
    ];
    bad.forEach((s, i) => {
      expect(isCadSave(s), `case ${i}`).toBe(false);
    });
    expect(isCadSave(mutate(() => undefined))).toBe(true);
    expect(isCadSave(mutate((s) => { s.trafficStop = null; }))).toBe(true);
  });
});
