import { describe, expect, it } from 'vitest';
import { commendationsFor } from '../../src/conduct/commendations';
import { COMMENDATION_CONFIG, parseCommendationConfig } from '../../src/conduct/data';
import { LogBuilder, addService, assess, det, forceEvent } from './helpers';

describe('commendationsFor', () => {
  const cfg = COMMENDATION_CONFIG;

  it('de-escalation: a threat, no force above verbal, and an arrest or release', () => {
    for (const ind of ['weaponSeen', 'weaponCall', 'assaultOnOfficer']) {
      const log = new LogBuilder().start().person(1, 's').indicator(1, ind).arrest(1).build();
      expect(commendationsFor(log, assess(log.key), cfg)).toEqual(['deEscalation']);
    }
    const release = new LogBuilder().start().person(1, 's').indicator(1, 'weaponSeen').release(1).build();
    expect(commendationsFor(release, assess(release.key), cfg)).toEqual(['deEscalation']);
  });

  it('de-escalation allows a presence display and verbal force but not more', () => {
    const ok = new LogBuilder().start().person(1, 's').indicator(1, 'weaponSeen').force(1, 'presence', 'assaultive').force(1, 'verbal', 'active').release(1).build();
    expect(commendationsFor(ok, assess(ok.key), cfg)).toEqual(['deEscalation']);
    const hands = new LogBuilder().start().person(1, 's').indicator(1, 'weaponSeen').force(1, 'softHands', 'active').release(1).build();
    expect(commendationsFor(hands, assess(hands.key), cfg)).toEqual([]);
  });

  it('de-escalation needs a threat indicator and an ending', () => {
    const noThreat = new LogBuilder().start().person(1, 's').indicator(1, 'speeding').release(1).build();
    expect(commendationsFor(noThreat, assess(noThreat.key), cfg)).toEqual([]);
    const open = new LogBuilder().start().person(1, 's').indicator(1, 'weaponSeen').build();
    expect(commendationsFor(open, assess(open.key), cfg)).toEqual([]);
  });

  it('lifesaving: EMS requested quickly on a medical / crisis / collision call', () => {
    for (const family of ['medical', 'crisis', 'collision']) {
      const log = ems(family, 100);
      expect(commendationsFor(log, assess(log.key), cfg)).toEqual(['lifesaving']);
    }
    expect(commendationsFor(ems('collision', 130), assess('k'), cfg)).toEqual([]);
    expect(commendationsFor(ems('collision', 120), assess('k'), cfg)).toEqual(['lifesaving']);
    expect(commendationsFor(ems('trafficStop', 10), assess('k'), cfg)).toEqual([]);
  });

  it('lifesaving: EMS requested soon after force that injured', () => {
    const b = new LogBuilder('k', 'disturbance').start().person(1, 's').after(5).force(1, 'baton', 'active');
    const id = b.lastId;
    const log = addService(b.build(), 35, 'ems', 'requested');
    expect(commendationsFor(log, assess('k'), cfg)).toEqual([]);
    forceEvent(log, id).injury = 0.4;
    expect(commendationsFor(log, assess('k'), cfg)).toEqual(['lifesaving']);
    const late = new LogBuilder('k', 'disturbance').start().person(1, 's').force(1, 'baton', 'active');
    const lateId = late.lastId;
    const l = addService(late.build(), 500, 'ems', 'requested');
    forceEvent(l, lateId).injury = 0.4;
    expect(commendationsFor(l, assess('k'), cfg)).toEqual([]);
    // an arrival is not a request
    const arrived = addService(new LogBuilder('k', 'collision').start().person(1, 's').build(), 10, 'ems', 'arrived');
    expect(commendationsFor(arrived, assess('k'), cfg)).toEqual([]);
  });

  it('dutyToIntervene: one per lawful intervene determination', () => {
    const log = new LogBuilder().start().person(1, 's').build();
    const a = assess(log.key, { dets: [det('intervene', 'lawful', [1]), det('intervene', 'lawful', [2]), det('intervene', 'unlawful', [3]), det('force', 'lawful', [4])] });
    expect(commendationsFor(log, a, cfg)).toEqual(['dutyToIntervene', 'dutyToIntervene']);
  });

  it('only fires rules present in the configuration', () => {
    const only = parseCommendationConfig({ version: 1, rules: [{ id: 'dutyToIntervene', label: 'X', points: 1 }] });
    const log = new LogBuilder().start().person(1, 's').indicator(1, 'weaponSeen').release(1).build();
    expect(commendationsFor(log, assess(log.key, { dets: [det('intervene', 'lawful', [1])] }), only)).toEqual(['dutyToIntervene']);
  });
});

function ems(family: string, after: number) {
  return addService(new LogBuilder('k', family).start().person(1, 's').build(), after, 'ems', 'requested');
}
