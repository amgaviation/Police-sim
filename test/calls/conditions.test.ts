import { describe, expect, it } from 'vitest';
import { familyDef, type Cond, type FamilyDef } from '../../src/calls/catalog';
import { toDnf } from '../../src/calls/cond';
import { condAtoms, evalCond, objectivesFor, outcomeFor, producibleFlags } from '../../src/calls/conditions';

const flags = (...f: string[]): Set<string> => new Set(f);
const fam = (id: string): FamilyDef => {
  const f = familyDef(id);
  if (!f) throw new Error(id);
  return f;
};
const branch = (f: FamilyDef, id: string): FamilyDef['branches'][number] => {
  const b = f.branches.find((x) => x.id === id);
  if (!b) throw new Error(id);
  return b;
};

describe('evalCond', () => {
  it('evaluates atoms, negation, all, any and not', () => {
    expect(evalCond('true', flags())).toBe(true);
    expect(evalCond('!true', flags())).toBe(false);
    expect(evalCond('a', flags('a'))).toBe(true);
    expect(evalCond('a', flags())).toBe(false);
    expect(evalCond('!a', flags())).toBe(true);
    expect(evalCond('!a', flags('a'))).toBe(false);
    expect(evalCond({ all: ['a', 'b'] }, flags('a', 'b'))).toBe(true);
    expect(evalCond({ all: ['a', 'b'] }, flags('a'))).toBe(false);
    expect(evalCond({ any: ['a', 'b'] }, flags('b'))).toBe(true);
    expect(evalCond({ any: ['a', 'b'] }, flags())).toBe(false);
    expect(evalCond({ not: { any: ['a', 'b'] } }, flags())).toBe(true);
    expect(evalCond({ not: 'a' }, flags('a'))).toBe(false);
    expect(evalCond({ all: ['a', { any: ['!b', 'c'] }] }, flags('a', 'b', 'c'))).toBe(true);
    expect(evalCond({ all: [] }, flags())).toBe(true);
    expect(evalCond({ any: [] }, flags('a'))).toBe(false);
  });

  it('lists distinct atoms without negation marks or true', () => {
    expect(condAtoms({ all: ['a', '!b', { any: ['a', 'true', { not: 'c:x' }] }] })).toEqual(['a', 'b', 'c:x']);
    expect(condAtoms('true')).toEqual([]);
  });
});

describe('disjunctive normal form', () => {
  const holds = (c: Cond, f: Set<string>): boolean =>
    toDnf(c).some((t) => t.pos.every((p) => f.has(p)) && t.neg.every((n) => !f.has(n)));

  it('matches evalCond on every assignment of three atoms', () => {
    const conds: Cond[] = [
      { all: ['a', { any: ['b', '!c'] }] },
      { not: { all: ['a', 'b'] } },
      { not: { any: ['a', { all: ['b', '!c'] }] } },
      { any: [{ all: ['a', 'b'] }, { all: ['!a', 'c'] }] },
      'true',
      '!true',
      { all: ['a', '!a'] },
    ];
    for (const c of conds) {
      for (let mask = 0; mask < 8; mask++) {
        const f = new Set(['a', 'b', 'c'].filter((_, i) => (mask >> i) & 1));
        expect(holds(c, f), `${JSON.stringify(c)} / ${[...f].join(',')}`).toBe(evalCond(c, f));
      }
    }
  });

  it('drops contradictory terms', () => {
    expect(toDnf({ all: ['a', '!a'] })).toEqual([]);
    expect(toDnf('!true')).toEqual([]);
    expect(toDnf('true')).toEqual([{ pos: [], neg: [] }]);
  });
});

describe('outcomeFor and objectivesFor', () => {
  const domestic = fam('domestic');

  it('picks the first matching outcome', () => {
    expect(outcomeFor(domestic, flags()).id).toBe('default');
    expect(outcomeFor(domestic, flags('variant:false', 'custody:suspect')).id).toBe('unfounded');
    expect(outcomeFor(domestic, flags('custody:suspect', 'branch:assault')).id).toBe('arrestSuspect');
    expect(outcomeFor(domestic, flags('branch:assault')).id).toBe('assaultNoArrest');
    expect(outcomeFor(domestic, flags('statement:victim', 'separated')).id).toBe('verbalHandled');
    expect(outcomeFor(domestic, flags('branch:suspectGone')).disposition).toBe('reportTaken');
  });

  it('lists only the shown objectives with their done state', () => {
    const base = objectivesFor(domestic, flags());
    expect(base.map((o) => o.text)).toEqual(['Locate and separate the parties']);
    expect(base[0]?.done).toBe(false);
    const shown = objectivesFor(domestic, flags('role:caller', 'role:victim', 'injury:victim', 'contacted:caller', 'custody:suspect'));
    expect(shown.map((o) => o.text)).toEqual([
      'Contact the reporting party', 'Locate and separate the parties', 'Get a statement from the victim', 'Victim injured: request EMS', 'Control the bleeding',
    ]);
    expect(shown.map((o) => o.done)).toEqual([true, true, false, false, false]);
  });
});

describe('producibleFlags', () => {
  const dui = fam('dui');
  const domestic = fam('domestic');

  it('gives role-scoped flags for present person roles only', () => {
    const f = producibleFlags(domestic, branch(domestic, 'verbal'));
    for (const x of ['custody:suspect', 'statement:victim', 'contacted:caller', 'fled:suspect', 'escaped:suspect', 'warned:suspect', 'near:victim']) {
      expect(f.has(x), x).toBe(true);
    }
    expect(f.has('custody:driver')).toBe(false);
    const gone = producibleFlags(domestic, branch(domestic, 'suspectGone'));
    expect(gone.has('custody:suspect')).toBe(false);
    expect(gone.has('statement:victim')).toBe(true);
  });

  it('adds transported only with requestEms, found/revealed for hidden or inside spots', () => {
    expect(producibleFlags(domestic, branch(domestic, 'assault')).has('transported:victim')).toBe(true);
    // Nobody who cannot be hurt is taken away (a verbal dispute, a shoplifter).
    expect(producibleFlags(domestic, branch(domestic, 'verbal')).has('transported:victim')).toBe(false);
    const crisis = fam('crisis');
    expect(producibleFlags(crisis, branch(crisis, 'talkDown')).has('transported:subject')).toBe(true);
    const retail = fam('retail');
    expect(producibleFlags(retail, branch(retail, 'detained')).has('transported:suspect')).toBe(false);
    expect(producibleFlags(retail, branch(retail, 'fled')).has('found:suspect')).toBe(true);
    expect(producibleFlags(retail, branch(retail, 'detained')).has('found:suspect')).toBe(false);
    expect(producibleFlags(domestic, branch(domestic, 'verbal')).has('found:suspect')).toBe(true);
    expect(producibleFlags(domestic, branch(domestic, 'verbal')).has('found:victim')).toBe(false);
    const missing = fam('missing');
    expect(producibleFlags(missing, branch(missing, 'foundNearby')).has('found:missing')).toBe(true);
  });

  it('adds breath and field tests for intoxicated roles and the dui family', () => {
    const f = producibleFlags(dui, branch(dui, 'tired'));
    for (const x of ['bacOver', 'sfstFail', 'pbt:driver', 'sfst:driver', 'itemFound:openContainer']) expect(f.has(x), x).toBe(true);
    const d = producibleFlags(domestic, branch(domestic, 'verbal'));
    expect(d.has('bacOver')).toBe(true);
    const retail = fam('retail');
    expect(producibleFlags(retail, branch(retail, 'detained')).has('bacOver')).toBe(false);
    expect(producibleFlags(retail, branch(retail, 'detained')).has('pbt:suspect')).toBe(false);
  });

  it('adds pursuit flags for fleeing vehicles and the pursuit family only', () => {
    const f = producibleFlags(dui, branch(dui, 'drunk'));
    for (const x of ['pursuit', 'pursuitLost', 'pursuitEnded', 'vehicleStopped']) expect(f.has(x), x).toBe(true);
    expect(producibleFlags(domestic, branch(domestic, 'verbal')).has('pursuit')).toBe(false);
    const pursuit = fam('pursuit');
    expect(producibleFlags(pursuit, branch(pursuit, 'footOnly')).has('pursuitLost')).toBe(true);
  });

  it('adds variant, action, service, item and weapon flags', () => {
    const f = producibleFlags(domestic, branch(domestic, 'verbal'));
    for (const x of ['escalated', 'deescalated', 'knocked', 'separated', 'photographed', 'evidenceCollected', 'service:ems', 'arrived:ems',
      'report', 'cited', 'forceUsed', 'arrived', 'itemFound:knife', 'itemFound:brokenGlass', 'weaponFound', 'attacked', 'shotsFired']) {
      expect(f.has(x), x).toBe(true);
    }
    const welfare = fam('welfare');
    const w = producibleFlags(welfare, branch(welfare, 'fine'));
    expect(w.has('escalated')).toBe(false);
    expect(w.has('attacked')).toBe(false);
    expect(w.has('weaponFound')).toBe(false);
    expect(w.has('guardianNotified')).toBe(true);
    const hazard = fam('hazard');
    const h = producibleFlags(hazard, branch(hazard, 'spill'));
    for (const x of ['arrived:hazmat', 'arrived:fire', 'hazmatHandled', 'fireOnScene', 'areaCleared', 'perimeter', 'evacuated']) expect(h.has(x), x).toBe(true);
    const crowd = fam('crowd');
    expect(producibleFlags(crowd, branch(crowd, 'unruly')).has('crowdDispersed')).toBe(true);
    expect(producibleFlags(domestic, branch(domestic, 'verbal')).has('crowdDispersed')).toBe(false);
  });

  it('skips person flags of dogs and keeps near:', () => {
    const animal = fam('animal');
    const f = producibleFlags(animal, branch(animal, 'stray'));
    expect(f.has('near:animal')).toBe(true);
    expect(f.has('custody:animal')).toBe(false);
    expect(f.has('role:owner')).toBe(false);
    expect(f.has('animalSecured')).toBe(true);
  });

  it('only allows juvenile flags for roles whose age can be under 18', () => {
    const missing = fam('missing');
    expect(producibleFlags(missing, branch(missing, 'foundNearby')).has('juvenile:missing')).toBe(true);
    expect(producibleFlags(missing, branch(missing, 'elderly')).has('juvenile:missing')).toBe(false);
    expect(producibleFlags(domestic, branch(domestic, 'verbal')).has('juvenile:victim')).toBe(false);
    expect(producibleFlags(domestic, branch(domestic, 'verbal')).has('juvenile:caller')).toBe(true);
  });
});
