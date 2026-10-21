import { describe, expect, it } from 'vitest';
import { isCadSave, type CadSave } from '../../src/cad/cadState';
import {
  CALL_TYPES,
  PLATE_ISSUES,
  PLATE_MAP,
  POI_LOCATION_KINDS,
  STATUTES,
  STATUTE_CATEGORIES,
  STATUTE_CLASSES,
  VIOLATION_MAP,
  findStatute,
  statuteForPlateIssue,
  statuteForViolation,
} from '../../src/cad/data';
import { CALL_STATUSES, CALLER_KINDS, REQUEST_VIAS, STOP_ACTIONS, STOP_OUTCOMES, UNIT_STATUSES, type TrafficStopInfo } from '../../src/cad/types';
import { isUnitRequest } from '../../src/dispatch/save';
import { addRoster, at, newCall, recordingCad } from './helpers';

/** The fixed id lists of the CAD contract (design §4.1, §6.1): each id is handled, anything else is refused. */

type Json = Record<string, unknown>;

/** A save with two calls (one open, one closed), three units, a documents block and an active stop. */
function sampleSave(): CadSave {
  const { cad } = recordingCad();
  addRoster(cad);
  const open = cad.createCall(newCall('alarm', 2), at(1));
  cad.assign(open.id, '21', at(2), 'dispatch');
  const done = cad.createCall(newCall(), at(3));
  cad.closeCall(done.id, 'handled', at(4));
  cad.docs.create('report', { title: 'R', callId: open.id }, at(5), 'Officer Doe');
  const stop: TrafficStopInfo = {
    callId: open.id, vehicleId: 3, plate: 'ABC 123', x: 1, z: 2, started: at(6), driverId: -1, trueDriverId: 4, plateRun: false, vinChecked: false,
    vinResult: '', citations: [], outcome: 'active',
  };
  cad.setTrafficStop(stop, at(6));
  return JSON.parse(JSON.stringify(cad.serialize())) as CadSave;
}

function mutate(change: (save: Json) => void): unknown {
  const save = sampleSave() as unknown as Json;
  change(save);
  return save;
}

describe('CALLER_KINDS', () => {
  it('lists the five kinds', () => {
    expect([...CALLER_KINDS]).toEqual(['citizen', 'anonymous', 'alarm', 'business', 'officer']);
  });

  it.each(CALLER_KINDS.map((k) => [k] as const))('stores a %s caller on a call and accepts it in a save', (kind) => {
    const { cad } = recordingCad();
    const call = cad.createCall({ ...newCall(), caller: { kind, name: 'N', phone: '555-0100', personId: -1 } }, at(1));
    expect(call.caller.kind).toBe(kind);
    expect(isCadSave(cad.serialize())).toBe(true);
  });

  it('refuses an unknown caller kind in a save', () => {
    expect(isCadSave(mutate((s) => { ((s.calls as Json[])[0]?.caller as Json).kind = 'robot'; }))).toBe(false);
    expect(isCadSave(sampleSave())).toBe(true);
  });

  it('is what the call types draw their callers from', () => {
    for (const t of CALL_TYPES) for (const kind of Object.keys(t.callers)) expect(CALLER_KINDS as readonly string[], `${t.id}: ${kind}`).toContain(kind);
  });
});

describe('CALL_STATUSES', () => {
  it('lists pending, active and closed', () => {
    expect([...CALL_STATUSES]).toEqual(['pending', 'active', 'closed']);
  });

  it.each(CALL_STATUSES.map((s) => [s] as const))('accepts a saved call that is %s', (status) => {
    expect(isCadSave(mutate((s) => { (s.calls as Json[])[0]!.status = status; }))).toBe(true);
  });

  it('refuses an unknown call status in a save and follows the lifecycle in the state', () => {
    expect(isCadSave(mutate((s) => { (s.calls as Json[])[0]!.status = 'archived'; }))).toBe(false);
    const { cad } = recordingCad();
    addRoster(cad);
    const call = cad.createCall(newCall(), at(1));
    const seen = [call.status];
    cad.assign(call.id, '21', at(2), 'dispatch');
    seen.push(call.status);
    cad.unassign('21', at(3));
    seen.push(call.status);
    cad.assign(call.id, '21', at(4), 'dispatch');
    cad.closeCall(call.id, 'handled', at(5));
    seen.push(call.status);
    expect(seen).toEqual(['pending', 'active', 'pending', 'closed']);
    for (const s of seen) expect(CALL_STATUSES as readonly string[]).toContain(s);
  });
});

describe('STOP_OUTCOMES', () => {
  it('lists the four outcomes', () => {
    expect([...STOP_OUTCOMES]).toEqual(['active', 'released', 'arrest', 'lost']);
  });

  it.each(STOP_OUTCOMES.map((o) => [o] as const))('accepts a stop with outcome %s in a save and applies it through updateTrafficStop', (outcome) => {
    expect(isCadSave(mutate((s) => { (s.trafficStop as Json).outcome = outcome; }))).toBe(true);
    const { cad } = recordingCad();
    cad.setTrafficStop({
      callId: 1, vehicleId: 3, plate: 'ABC 123', x: 1, z: 2, started: at(1), driverId: -1, trueDriverId: 4, plateRun: false, vinChecked: false,
      vinResult: '', citations: [], outcome: 'active',
    }, at(1));
    cad.updateTrafficStop({ outcome }, at(2));
    expect(cad.trafficStop?.outcome).toBe(outcome);
  });

  it('ignores an unknown outcome in a patch and refuses it in a save', () => {
    expect(isCadSave(mutate((s) => { (s.trafficStop as Json).outcome = 'fled'; }))).toBe(false);
    const { cad, events } = recordingCad();
    cad.setTrafficStop({
      callId: 1, vehicleId: 3, plate: 'ABC 123', x: 1, z: 2, started: at(1), driverId: -1, trueDriverId: 4, plateRun: false, vinChecked: false,
      vinResult: '', citations: [], outcome: 'active',
    }, at(1));
    events.length = 0;
    cad.updateTrafficStop({ outcome: 'fled' as 'lost' }, at(2));
    expect(cad.trafficStop?.outcome).toBe('active');
    expect(events).toEqual([]);
  });

  it('announces the end of the stop for every outcome but active', () => {
    for (const outcome of STOP_OUTCOMES) {
      const { cad, events } = recordingCad();
      cad.setTrafficStop({
        callId: 1, vehicleId: 3, plate: 'ABC 123', x: 1, z: 2, started: at(1), driverId: -1, trueDriverId: 4, plateRun: false, vinChecked: false,
        vinResult: '', citations: [], outcome: 'active',
      }, at(1));
      events.length = 0;
      cad.updateTrafficStop({ outcome }, at(2));
      expect(events.filter((e) => e.topic === 'cad:trafficStop').map((e) => (e.payload as { active: boolean }).active)).toEqual(outcome === 'active' ? [] : [false]);
    }
  });
});

describe('STOP_ACTIONS', () => {
  it('lists the five contact actions', () => {
    expect([...STOP_ACTIONS]).toEqual(['license', 'vin', 'warn', 'release', 'arrest']);
  });

  it.each(STOP_ACTIONS.map((a) => [a] as const))('lets a queued stopContact request carry the %s action', (action) => {
    expect(isUnitRequest({ kind: 'stopContact', action })).toBe(true);
    expect(isUnitRequest({ kind: 'stopContact', action, personId: 7 })).toBe(true);
    expect(isUnitRequest({ kind: 'stopContact', action, personId: -1 })).toBe(true);
    expect(isUnitRequest({ kind: 'stopContact', action, personId: -2 })).toBe(false);
  });

  it('refuses an action that is not listed', () => {
    for (const action of ['cite', 'search', '', 'License']) expect(isUnitRequest({ kind: 'stopContact', action })).toBe(false);
    expect(isUnitRequest({ kind: 'stopContact' })).toBe(false);
  });
});

describe('REQUEST_VIAS', () => {
  it('lists the five ways to make a request', () => {
    expect([...REQUEST_VIAS]).toEqual(['radio', 'mdt', 'voice', 'key', 'auto']);
  });

  it('is a distinct set from the unit statuses', () => {
    expect(UNIT_STATUSES.filter((s) => (REQUEST_VIAS as readonly string[]).includes(s))).toEqual([]);
  });
});

describe('statute vocabularies', () => {
  it('lists the categories and classes', () => {
    expect([...STATUTE_CATEGORIES]).toEqual(['traffic', 'criminal']);
    expect([...STATUTE_CLASSES]).toEqual(['infraction', 'misdemeanor', 'felony', 'warrant']);
  });

  it('gives every statute a listed category and class, and uses each of them somewhere', () => {
    for (const s of STATUTES) {
      expect(STATUTE_CATEGORIES as readonly string[], s.id).toContain(s.category);
      expect(STATUTE_CLASSES as readonly string[], s.id).toContain(s.cls);
    }
    for (const c of STATUTE_CATEGORIES) expect(STATUTES.some((s) => s.category === c), c).toBe(true);
    for (const c of STATUTE_CLASSES) expect(STATUTES.some((s) => s.cls === c), c).toBe(true);
  });

  it('keeps infractions citeable and not bookable, and warrants bookable and not citeable', () => {
    for (const s of STATUTES) {
      if (s.cls === 'infraction') expect(s.citeable, s.id).toBe(true);
      if (s.cls === 'warrant') expect([s.id, s.citeable, s.bookable]).toEqual([s.id, false, true]);
      expect(s.citeable || s.bookable, `${s.id} is neither citeable nor bookable`).toBe(true);
    }
  });

  it('maps every violation kind and every plate issue to a statute that exists', () => {
    const kinds = Object.keys(VIOLATION_MAP);
    expect(kinds.length).toBeGreaterThanOrEqual(5);
    for (const kind of kinds) {
      const id = VIOLATION_MAP[kind] ?? '';
      expect(findStatute(id), `${kind} -> ${id}`).not.toBeNull();
      expect(statuteForViolation(kind)?.id).toBe(id);
    }
    expect(Object.keys(PLATE_MAP).sort()).toEqual([...PLATE_ISSUES].sort());
    for (const issue of PLATE_ISSUES) {
      expect(findStatute(PLATE_MAP[issue]), issue).not.toBeNull();
      expect(statuteForPlateIssue(issue)?.id).toBe(PLATE_MAP[issue]);
    }
  });

  it('maps the traffic violations the stop UI offers to citeable traffic statutes', () => {
    for (const kind of ['speeding', 'redLight', 'rollingStop', 'tailgating', 'weaving']) {
      const s = findStatute(VIOLATION_MAP[kind] ?? '');
      expect(s?.category, kind).toBe('traffic');
      expect(s?.citeable, kind).toBe(true);
    }
  });
});

describe('POI_LOCATION_KINDS', () => {
  it('lists the places a call type may be set at', () => {
    expect([...POI_LOCATION_KINDS]).toEqual(['station', 'hospital', 'campus', 'airport', 'harbor', 'school', 'fuel', 'park']);
  });

  it('is what every poi location of the call types names', () => {
    const poi = CALL_TYPES.filter((t) => t.location.startsWith('poi:'));
    expect(poi.length).toBeGreaterThan(0);
    for (const t of poi) expect(POI_LOCATION_KINDS as readonly string[], `${t.id}: ${t.location}`).toContain(t.location.slice(4));
    for (const t of CALL_TYPES.filter((x) => !x.location.startsWith('poi:'))) expect(['road', 'block', 'intersection']).toContain(t.location);
  });
});
