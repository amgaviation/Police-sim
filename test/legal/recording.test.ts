import { describe, expect, it } from 'vitest';
import { CAM } from '../../src/legal/types';
import { dets, drugs, evaluate, LogBuilder, one } from './helpers';

/** A person met at t = 0 with the body camera on. */
function contact(): LogBuilder {
  return new LogBuilder().start().person(1, 'driver').indicator(1, 'speeding').detain(1);
}

describe('recording policy', () => {
  it('a search with the body camera off 30 s after the first contact violates the recording rule', () => {
    const b = contact();
    b.at(5).cam(false);
    const search = b.at(30).search(1, 'vehicle', [drugs()], {}).lastId;
    const a = evaluate(b.build());
    const d = one(a, 'recording');
    expect(d).toMatchObject({ outcome: 'unlawful', ruleIds: ['GS-11.1'], eventIds: [search], eventId: search });
    expect(a.summary.score).toBeLessThan(100);
  });

  it('within the activation grace nothing is flagged, and strict has a shorter grace', () => {
    const b = contact();
    b.at(1).cam(false);
    b.at(8).frisk(1);
    const log = b.build();
    expect(dets(evaluate(log, 'generic'), 'recording')).toHaveLength(0);
    expect(dets(evaluate(log, 'strict'), 'recording')).toHaveLength(1);
  });

  it('muting during force is a mute violation, not a missing recording', () => {
    const b = contact();
    b.at(20).cam(true, true);
    const force = b.at(25).force(1, 'hardHands', 'active').lastId;
    const a = evaluate(b.build());
    expect(dets(a, 'recording')).toHaveLength(1);
    expect(one(a, 'recording')).toMatchObject({ ruleIds: ['GS-11.2'], eventIds: [force] });
  });

  it('collects every violating event into one determination per rule', () => {
    const b = contact();
    b.at(20).cam(false);
    const f = b.at(25).frisk(1).lastId;
    const s = b.at(30).search(1, 'person').lastId;
    b.at(40).cam(true, true);
    const m = b.at(45).arrest(1).lastId;
    const a = evaluate(b.build());
    const list = dets(a, 'recording');
    expect(list.map((d) => d.ruleIds)).toEqual([['GS-11.1'], ['GS-11.2']]);
    expect(list[0]?.eventIds).toEqual([f, s]);
    expect(list[1]?.eventIds).toEqual([m]);
    // the frisk lacks a basis (15); the search is a lawful pre-arrest search; two recording determinations cost 8 each
    expect(a.summary).toMatchObject({ unlawful: 1, score: 100 - 15 - 16 });
  });

  it('the dash camera counts for detentions and pursuit samples only', () => {
    const b = contact();
    b.at(20).cam(false, false, true);
    b.at(25).detain(2, 'trafficStop');
    const search = b.at(30).search(1, 'vehicle').lastId;
    const a = evaluate(b.build());
    expect(one(a, 'recording').eventIds).toEqual([search]);
  });

  it('pursuit samples need the dash or the body camera', () => {
    const b = new LogBuilder('C-9', 'vehicleWanted').start().person(1, 'driver').indicator(1, 'stolenVehicle', 'lookup');
    b.at(1).pursuit(1);
    b.at(2).sample(1, 50);
    b.at(30).cam(false, false, true);
    b.at(31).sample(1, 50);
    b.at(32).cam(false);
    const bad = b.at(33).sample(1, 50).lastId;
    const a = evaluate(b.build());
    expect(one(a, 'recording').eventIds).toEqual([bad]);
  });

  it('presence-level force and non-custodial questions need no recording', () => {
    const b = contact();
    b.at(20).cam(false);
    b.at(25).force(1, 'presence', 'compliant');
    b.at(26).question(1, 'name', false);
    b.at(27).question(1, 'account', false);
    expect(dets(evaluate(b.build()), 'recording')).toHaveLength(0);
  });

  it('a custodial question is recorded', () => {
    const b = contact();
    b.at(20).cam(false);
    const q = b.at(25).question(1, 'account', true).lastId;
    expect(one(evaluate(b.build()), 'recording').eventIds).toEqual([q]);
  });

  it('each person has their own activation grace', () => {
    const b = contact();
    b.at(100).cam(false);
    b.at(100).person(2, 'passenger');
    b.at(105).frisk(2);
    expect(dets(evaluate(b.build()), 'recording')).toHaveLength(0);
    const late = contact();
    late.at(100).cam(false);
    late.at(100).person(2, 'passenger');
    late.at(115).frisk(2);
    expect(dets(evaluate(late.build()), 'recording')).toHaveLength(1);
    expect(CAM.body).toBe(1);
  });
});
