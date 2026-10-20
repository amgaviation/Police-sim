import { describe, expect, it } from 'vitest';
import { both, drugs, evaluate, LogBuilder, one, gun } from './helpers';

describe('evidence chain', () => {
  it('unlawful entry -> plain view -> seizure: all inadmissible, rooted at the entry', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    const entry = b.entry(5, false, 1).lastId;
    const search = b.at(2).search(1, 'room', [drugs('d1')], { claimedBasis: 'plainView', buildingId: 5 }).lastId;
    b.at(3).seize(1, drugs('d1'), search);
    b.at(4).seize(1, gun('g9'), search);
    const a = evaluate(b.build());
    expect(a.evidence).toHaveLength(2);
    for (const r of a.evidence) {
      expect(r).toMatchObject({ admissible: false, taintedBy: entry, ruleIds: ['GS-12.2', 'GS-12.1'] });
    }
    expect(a.evidence.map((r) => r.ref)).toEqual(['d1', 'g9']);
    expect(a.summary.suppressed).toBe(2);
  });

  it('a seizure from a lawful search is admissible', () => {
    const b = new LogBuilder().start().person(1, 'suspect').indicator(1, 'warrantHit', 'lookup').detain(1).at(2).arrest(1);
    const search = b.at(5).search(1, 'person', [drugs()]).lastId;
    b.at(6).seize(1, drugs(), search);
    const a = evaluate(b.build());
    expect(a.evidence).toHaveLength(1);
    expect(a.evidence[0]?.admissible).toBe(true);
  });

  it('inevitable discovery rescues an unlawful frisk find in generic but not in strict', () => {
    const b = new LogBuilder().start().person(1, 'suspect').indicator(1, 'trafficViolation').detain(1);
    const frisk = b.at(5).frisk(1, [drugs()]).lastId;
    b.at(8).indicator(1, 'warrantHit', 'lookup');
    b.at(10).arrest(1);
    const { generic, strict } = both(b.build());
    expect(generic.evidence[0]).toMatchObject({ admissible: true, ruleIds: ['GS-12.3'], taintedBy: -1 });
    expect(generic.evidence[0]?.reason).toContain('later lawful arrest');
    expect(strict.evidence[0]).toMatchObject({ admissible: false, taintedBy: frisk, ruleIds: ['SS-12.1'] });
    expect(generic.summary.suppressed).toBe(0);
    expect(strict.summary.suppressed).toBe(1);
  });

  it('inevitable discovery needs a later lawful arrest', () => {
    const b = new LogBuilder().start().person(1, 'suspect').indicator(1, 'trafficViolation').detain(1);
    b.at(5).frisk(1, [drugs()]);
    expect(evaluate(b.build()).evidence[0]?.admissible).toBe(false);
  });

  it('inevitable discovery does not apply to a vehicle search', () => {
    const b = new LogBuilder().start().person(1, 'suspect').indicator(1, 'flight').indicator(1, 'falseIdentity').detain(1);
    b.at(5).search(1, 'vehicle', [drugs()]);
    b.at(8).indicator(1, 'warrantHit', 'lookup');
    b.at(10).arrest(1);
    // the search lacked probable cause at the time, and only person searches can be rescued
    expect(evaluate(b.build()).evidence[0]?.admissible).toBe(false);
  });

  it('an independent lawful second search of the same item gives an admissible later ruling', () => {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'speeding').detain(1);
    const first = b.at(5).search(1, 'vehicle', [drugs('x1')]).lastId;
    b.at(20).consent(1, 'searchVehicle');
    const second = b.at(21).search(1, 'vehicle', [drugs('x1')]).lastId;
    const a = evaluate(b.build());
    expect(a.evidence).toHaveLength(2);
    expect(a.evidence[0]).toMatchObject({ eventId: first, admissible: false });
    expect(a.evidence[1]).toMatchObject({ eventId: second, admissible: true, ref: 'x1' });
  });

  it('tests are evidence', () => {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'speeding').detain(1);
    b.at(3).consent(1, 'pbt');
    b.at(4).test(1, 'pbt', 'over');
    b.at(6).test(1, 'sfst', 'fail');
    const a = evaluate(b.build());
    expect(a.evidence.map((r) => [r.kind, r.admissible])).toEqual([['test', true], ['test', false]]);
  });
});

describe('ruleset swap', () => {
  /** One log that exercises many rules: the same facts give different determinations per ruleset. */
  function busyLog() {
    const b = new LogBuilder('C-00077', 'trafficStop').start().person(1, 'driver');
    b.indicator(1, 'speeding').indicator(1, 'weaponCall', 'call');
    b.detain(1);
    b.at(5).frisk(1, [drugs()]);
    b.at(8).question(1, 'account', false, true);
    b.at(10).arrest(1);
    b.at(12).test(1, 'pbt', 'over');
    b.at(14).search(1, 'vehicle', [drugs('v1')]);
    b.at(16).force(1, 'taser', 'active');
    b.at(18).force(1, 'presence', 'compliant', { tool: 'firearmDisplay' });
    return b.build();
  }

  it('gives at least four different determinations across the two rulesets', () => {
    const { generic, strict } = both(busyLog());
    const key = (a: typeof generic) => new Map(a.determinations.map((d) => [`${d.doctrine}:${d.eventId}`, d.outcome]));
    const g = key(generic);
    const s = key(strict);
    const differing = new Set([...g.keys(), ...s.keys()].filter((k) => g.get(k) !== s.get(k)));
    expect(differing.size).toBeGreaterThanOrEqual(4);
    expect(generic.rulesetId).toBe('generic');
    expect(strict.rulesetId).toBe('strict');
    expect(generic.summary.score).toBeGreaterThan(strict.summary.score);
  });

  it('names the differing rules', () => {
    const { generic, strict } = both(busyLog());
    expect(one(generic, 'arrest').outcome).toBe('lawful');
    expect(one(strict, 'arrest').outcome).toBe('unlawful');
    expect(one(generic, 'test').outcome).toBe('lawful');
    expect(one(strict, 'test').outcome).toBe('unlawful');
    expect(strict.determinations.some((d) => d.doctrine === 'miranda')).toBe(true);
    expect(generic.determinations.some((d) => d.doctrine === 'miranda')).toBe(false);
  });
});
