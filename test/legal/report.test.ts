import { describe, expect, it } from 'vitest';
import { buildReportChoices } from '../../src/legal/report';
import { getRuleset } from '../../src/legal/ruleset';
import type { IncidentLog, LegalAssessment, ReportChoice } from '../../src/legal/types';
import { drugs, evaluate, gun, LogBuilder } from './helpers';

const generic = getRuleset('generic');

interface Scenario { log: IncidentLog; a: LegalAssessment; ids: Record<string, number> }

/** Impaired driver: stop, consent search, frisk, custodial questioning, force, arrest, seizure and a partner episode. */
function scenario(opts: { warn?: boolean; muted?: boolean } = {}): Scenario {
  const b = new LogBuilder('C-00021', 'dui').start().person(1, 'driver', 'Alex Driver').person(2, 'passenger', 'Sam Rider');
  b.indicator(1, 'trafficViolation').indicator(1, 'odorAlcohol').indicator(-1, 'boloMatch', 'lookup');
  b.at(1).detain(1);
  b.at(2).consent(1, 'searchVehicle');
  const search = b.at(3).search(1, 'vehicle', [drugs('d1')]).lastId;
  b.at(4).seize(1, drugs('d1'), search);
  const frisk = b.at(5).frisk(1, [gun()]).lastId;
  if (opts.warn !== false) b.at(6).miranda(1, 'waived');
  const q = b.at(7).question(1, 'drinking', true).lastId;
  b.at(8).statement(1, 'drinking', 'two beers');
  b.indicator(1, 'admissionDrinking', 'statement', b.lastId);
  b.indicator(1, 'sfstFail', 'test');
  if (opts.muted) b.at(9).cam(true, true);
  const force = b.at(10).force(1, 'hardHands', 'active').lastId;
  const arrest = b.at(12).arrest(1).lastId;
  const other = b.at(20).other(1, 'baton', 'compliant', 5).lastId;
  b.at(22).intervene(other);
  const log = b.build();
  return { log, a: evaluate(log), ids: { search, frisk, q, force, arrest, other } };
}

function byId(list: ReportChoice[]): Map<string, ReportChoice> {
  return new Map(list.map((c) => [c.id, c]));
}

describe('buildReportChoices', () => {
  it('is deterministic for a seed and sorted by person then id', () => {
    const { log, a } = scenario();
    const one = buildReportChoices(log, a, generic, 1234);
    const two = buildReportChoices(log, a, generic, 1234);
    expect(two).toEqual(one);
    for (let i = 1; i < one.length; i++) {
      const p = one[i - 1];
      const c = one[i];
      if (!p || !c) continue;
      expect(p.personId < c.personId || (p.personId === c.personId && p.id < c.id)).toBe(true);
    }
    expect(new Set(one.map((c) => c.id)).size).toBe(one.length);
  });

  it('does not change the true choices with the seed, only the distractors', () => {
    const { log, a } = scenario();
    const trueIds = (seed: number) => buildReportChoices(log, a, generic, seed).filter((c) => c.truth !== 'false').map((c) => c.id);
    expect(trueIds(1)).toEqual(trueIds(99));
    const falseIds = (seed: number) => buildReportChoices(log, a, generic, seed).filter((c) => c.truth === 'false').map((c) => c.id).join();
    const seen = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(falseIds));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('contains every key fact with true statements', () => {
    const { log, a, ids } = scenario();
    const m = byId(buildReportChoices(log, a, generic, 7));
    const mustHave = [
      'ind:trafficViolation:1', 'ind:odorAlcohol:1', 'ind:sfstFail:1', 'ind:admissionDrinking:1', `frisk:${ids.frisk}`,
      `search:${ids.search}`, 'consent:searchVehicle:1', 'miranda:1', `res:${ids.force}:active`, 'arrest:1', 'pc:1:dui',
    ];
    for (const id of mustHave) {
      const c = m.get(id);
      expect(c, id).toBeDefined();
      expect(c?.truth, id).toBe('true');
      expect(c?.key, id).toBe(true);
    }
    const seize = [...m.values()].find((c) => c.id.startsWith('seize:'));
    expect(seize).toMatchObject({ truth: 'true', key: true, personId: 1 });
    expect(m.get('ind:boloMatch:-1')).toMatchObject({ truth: 'true', personId: -1 });
    // indicators with no pc / armed weight are not key facts
    expect(m.get('ind:trafficViolation:1')?.eventId).toBeGreaterThan(0);
    expect(m.get('intervene:' + ids.other)).toMatchObject({ truth: 'true', key: true });
  });

  it('uses first-person text with names filled in', () => {
    const { log, a } = scenario();
    const choices = buildReportChoices(log, a, generic, 7);
    for (const c of choices) expect(c.text).not.toMatch(/\{\w+\}/);
    expect(byId(choices).get('arrest:1')?.text).toBe('I arrested Alex Driver.');
    expect(byId(choices).get('miranda:1')?.text).toContain('Alex Driver');
    expect(byId(choices).get('cam:full')?.text).toBe('My body camera recorded the entire contact.');
  });

  it('never marks a distractor true', () => {
    const { log, a } = scenario();
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const choices = buildReportChoices(log, a, generic, seed);
      const m = byId(choices);
      const had = new Set(log.events.flatMap((e) => (e.kind === 'indicator' ? [`${e.indicator}:${e.personId}`] : [])));
      for (const c of choices) {
        if (c.truth !== 'false') continue;
        expect(c.key, c.id).toBe(false);
        if (c.id.startsWith('ind:')) {
          const [, ind, pid] = c.id.split(':');
          expect(had.has(`${ind}:${pid}`), c.id).toBe(false);
          expect(had.has(`${ind}:-1`), c.id).toBe(false);
          expect(c.eventId).toBe(-1);
        }
        if (c.id.startsWith('consent:')) {
          const [, kind, pid] = c.id.split(':');
          const granted = log.events.some((e) => e.kind === 'consent' && e.granted && e.consent === kind && String(e.personId) === pid);
          expect(granted, c.id).toBe(false);
        }
        if (c.id.startsWith('frisk:x:')) expect(log.events.some((e) => e.kind === 'frisk' && String(e.personId) === c.id.slice(8))).toBe(false);
        if (c.id.startsWith('search:x:')) expect(log.events.some((e) => e.kind === 'search' && e.target === 'vehicle' && String(e.personId) === c.id.slice(9))).toBe(false);
      }
      // a distractor never shadows a true id
      expect(m.size).toBe(choices.length);
    }
  });

  it('offers a distractor consent for the search target when it was never granted', () => {
    const b = new LogBuilder('C-5', 'trafficStop').start().person(1, 'driver').indicator(1, 'speeding').detain(1);
    b.at(3).frisk(1);
    b.at(4).search(1, 'vehicle');
    const log = b.build();
    const m = byId(buildReportChoices(log, evaluate(log), generic, 3));
    expect(m.get('consent:searchVehicle:1')).toMatchObject({ truth: 'false' });
    expect(m.has('frisk:x:1')).toBe(false);
    expect(m.has('search:x:1')).toBe(false);
  });

  it('offers a distractor frisk when none happened', () => {
    const b = new LogBuilder('C-6', 'trafficStop').start().person(1, 'driver').indicator(1, 'speeding').detain(1);
    const log = b.build();
    const m = byId(buildReportChoices(log, evaluate(log), generic, 3));
    expect(m.get('frisk:x:1')).toMatchObject({ truth: 'false', key: false });
  });

  it('gives each force event exactly five grouped choices with one true', () => {
    const { log, a, ids } = scenario();
    const choices = buildReportChoices(log, a, generic, 7).filter((c) => c.group === `res:${ids.force}`);
    expect(choices).toHaveLength(5);
    expect(choices.map((c) => c.id.split(':')[2]).sort()).toEqual(['active', 'assaultive', 'compliant', 'lethal', 'passive']);
    expect(choices.filter((c) => c.truth === 'true')).toHaveLength(1);
    expect(choices.find((c) => c.truth === 'true')).toMatchObject({ id: `res:${ids.force}:active`, key: true });
    expect(choices.find((c) => c.id.endsWith(':compliant'))?.text).toBe('Alex Driver was compliant when I used hard hands.');
    // all other choices have no group
    expect(buildReportChoices(log, a, generic, 7).filter((c) => c.group !== null)).toHaveLength(5);
  });

  it('presence-level force has no resistance choices', () => {
    const b = new LogBuilder().start().person(1, 'suspect').force(1, 'presence', 'compliant');
    const log = b.build();
    expect(buildReportChoices(log, evaluate(log), generic, 1).some((c) => c.id.startsWith('res:'))).toBe(false);
  });

  it('marks probable cause unsupported when below the threshold', () => {
    const b = new LogBuilder('C-8', 'dui').start().person(1, 'driver').indicator(1, 'odorAlcohol').indicator(1, 'weaving').detain(1);
    b.at(5).arrest(1);
    const log = b.build();
    const a = evaluate(log);
    expect(a.persons[0]?.arrestLawful).toBe(false);
    const m = byId(buildReportChoices(log, a, generic, 11));
    expect(m.get('pc:1:dui')).toMatchObject({ truth: 'unsupported', key: false });
    expect(m.get('arrest:1')).toMatchObject({ truth: 'true', key: true });
  });

  it('offers a second offense with indicators for probable cause', () => {
    const b = new LogBuilder('C-9', 'dui').start().person(1, 'driver').indicator(1, 'odorAlcohol').indicator(1, 'bacOver', 'test').indicator(1, 'speeding').detain(1);
    b.at(5).arrest(1);
    const log = b.build();
    const m = byId(buildReportChoices(log, evaluate(log), generic, 11));
    expect(m.get('pc:1:dui')).toMatchObject({ truth: 'true', key: true });
    expect(m.get('pc:1:traffic')).toMatchObject({ truth: 'true', key: false });
  });

  it('the miranda statement is false and not a key when no warning preceded the questioning', () => {
    const { log, a } = scenario({ warn: false });
    const c = byId(buildReportChoices(log, a, generic, 7)).get('miranda:1');
    expect(c).toMatchObject({ truth: 'false', key: false });
  });

  it('cam:full is false when a recording determination exists', () => {
    const ok = scenario();
    expect(byId(buildReportChoices(ok.log, ok.a, generic, 7)).get('cam:full')).toMatchObject({ truth: 'true' });
    const bad = scenario({ muted: true });
    expect(bad.a.determinations.some((d) => d.doctrine === 'recording')).toBe(true);
    expect(byId(buildReportChoices(bad.log, bad.a, generic, 7)).get('cam:full')).toMatchObject({ truth: 'false', key: false });
  });

  it('an intervene choice is false when the officer did not intervene', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    const other = b.at(5).other(1, 'baton', 'compliant', 4).lastId;
    const log = b.build();
    expect(byId(buildReportChoices(log, evaluate(log), generic, 1)).get(`intervene:${other}`)).toMatchObject({ truth: 'false', key: false });
  });

  it('works on an empty log', () => {
    const log = new LogBuilder().build();
    const choices = buildReportChoices(log, evaluate(log), generic, 1);
    expect(choices.map((c) => c.id)).toEqual(['cam:full']);
  });
});
