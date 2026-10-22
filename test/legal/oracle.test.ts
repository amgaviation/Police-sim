import { describe, expect, it } from 'vitest';
import { evaluateIncident } from '../../src/legal/evaluate';
import { getRuleset } from '../../src/legal/ruleset';
import { CORPUS, scenario } from './corpus';
import { EXPECTED, digest } from './expected';
import { LogBuilder, drugs, dets, evaluate, rulesetCopy } from './helpers';

/**
 * The corpus is an oracle: every scenario has an expected list of rulings under both shipped rulesets (`expected.ts`).
 * The targeted tests below pin the review-round gaps with a readable assertion each, including the behaviours that the two
 * shipped rulesets cannot tell apart (they need a ruleset copy).
 */

describe('corpus oracle', () => {
  it('has an expectation for every scenario and no stale ones', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(CORPUS.map((s) => s.id).sort());
  });

  describe.each(['generic', 'strict'] as const)('%s', (rulesetId) => {
    it.each(CORPUS.map((s) => [s.id, s.note] as const))('%s reaches the expected rulings (%s)', (id) => {
      const expected = EXPECTED[id]?.[rulesetId];
      expect(expected, `no expectation for ${id}`).toBeDefined();
      expect(digest(evaluate(scenario(id).log, rulesetId))).toEqual(expected);
    });
  });
});

describe('exigency is a basis for premises only', () => {
  it.each(['generic', 'strict'])('an active exigency never makes a person or a vehicle search lawful (%s)', (rulesetId) => {
    const a = evaluate(scenario('exigency-person-vehicle').log, rulesetId);
    expect(dets(a, 'search').map((d) => [d.outcome, d.basis])).toEqual([['unlawful', null], ['unlawful', null]]);
    expect(a.evidence.map((e) => e.admissible)).toEqual([false, false]);
  });

  it('is scoped to its building, and a call-wide one covers every building', () => {
    const other = evaluate(scenario('exigency-other-building').log);
    expect(dets(other, 'search').map((d) => [d.outcome, d.basis])).toEqual([['unlawful', null]]);
    const wide = new LogBuilder('C-w', 'domestic').start().person(1, 'suspect').after(1).exigency('screaming inside').after(1).entry(4, true, 1).after(1)
      .search(1, 'room', [drugs('w1')], { buildingId: 4 }).build();
    expect(dets(evaluate(wide), 'search').map((d) => [d.outcome, d.basis])).toEqual([['lawful', 'exigency']]);
  });
});

describe('claimed incident-to-arrest premises search window', () => {
  const basis = (id: string, rulesetId: string): unknown[] => dets(evaluate(scenario(id).log, rulesetId), 'search').map((d) => [d.outcome, d.basis]);

  it('is lawful just inside the window and unlawful well outside it', () => {
    expect(basis('premises-sita-claim', 'generic')).toEqual([['lawful', 'incidentToArrest']]);
    expect(basis('premises-sita-claim', 'strict')).toEqual([['lawful', 'incidentToArrest']]);
    expect(basis('premises-sita-outside', 'generic')).toEqual([['unlawful', null]]);
    expect(basis('premises-sita-outside', 'strict')).toEqual([['unlawful', null]]);
  });

  it('follows the ruleset window: 400 s is inside the generic one (600 s) and outside the strict one (300 s)', () => {
    expect(getRuleset('generic').sita.windowS).toBe(600);
    expect(getRuleset('strict').sita.windowS).toBe(300);
    expect(basis('premises-sita-edge', 'generic')).toEqual([['lawful', 'incidentToArrest']]);
    expect(basis('premises-sita-edge', 'strict')).toEqual([['unlawful', null]]);
  });

  it('is never lawful before the arrest', () => {
    const log = new LogBuilder('C-b', 'wanted').start().person(1, 'suspect').after(1).entry(10, true, 1).after(1)
      .search(1, 'room', [drugs('bf1')], { claimedBasis: 'incidentToArrest', buildingId: 10 }).after(1)
      .indicator(1, 'warrantHit').after(1).arrest(1).build();
    expect(dets(evaluate(log), 'search').map((d) => [d.outcome, d.basis])).toEqual([['unlawful', null]]);
  });
});

describe('a booking that is the only arrest', () => {
  it.each(['generic', 'strict'])('is judged: lawful with probable cause, unlawful without (%s)', (rulesetId) => {
    const lawful = evaluate(scenario('arrest-booking-only-pc').log, rulesetId);
    expect(dets(lawful, 'arrest').map((d) => [d.outcome, d.basis])).toEqual([['lawful', 'probableCause']]);
    expect(lawful.persons.find((p) => p.personId === 1)?.arrestLawful).toBe(true);
    const unlawful = evaluate(scenario('arrest-booking-only-no-pc').log, rulesetId);
    expect(dets(unlawful, 'arrest').map((d) => d.outcome)).toEqual(['unlawful']);
    expect(unlawful.persons.find((p) => p.personId === 1)?.arrestLawful).toBe(false);
  });

  it('a booking after a cuffing arrest is not a second arrest', () => {
    for (const rulesetId of ['generic', 'strict']) {
      expect(dets(evaluate(scenario('arrest-booking-duplicate').log, rulesetId), 'arrest')).toHaveLength(1);
    }
  });
});

describe('search just before an arrest', () => {
  it('is lawful only inside the pre-arrest window (generic: 60 s; strict has none)', () => {
    const search = (id: string, rulesetId: string): string[] => dets(evaluate(scenario(id).log, rulesetId), 'search').map((d) => d.outcome);
    expect(search('pre-arrest-search', 'generic')).toEqual(['lawful']);
    expect(search('pre-arrest-search', 'strict')).toEqual(['unlawful']);
    expect(search('pre-arrest-late', 'generic')).toEqual(['unlawful']);
  });

  it('counts only probable cause for an arrestable offense', () => {
    // The shipped rulesets cannot tell this apart (generic has a window but arrests for everything, strict has no window).
    const rs = rulesetCopy('strict', (r) => { r.sita.preArrestS = 60; });
    expect(rs.offenses.traffic.arrestable).toBe(false);
    const a = evaluateIncident(scenario('pre-arrest-speeding').log, rs);
    expect(dets(a, 'search').map((d) => [d.outcome, d.basis])).toEqual([['unlawful', null]]);
    expect(dets(a, 'arrest').map((d) => d.outcome)).toEqual(['unlawful']);
    // With a drug offense the same window makes the search lawful.
    const drug = evaluateIncident(scenario('pre-arrest-search').log, rs);
    expect(dets(drug, 'search').map((d) => [d.outcome, d.basis])).toEqual([['lawful', 'incidentToArrest']]);
  });
});

describe('building-scoped consent', () => {
  const search = (id: string, rulesetId: string): unknown[] => dets(evaluate(scenario(id).log, rulesetId), 'search').map((d) => [d.outcome, d.basis]);

  it.each(['generic', 'strict'])("an occupant's consent for the building covers the officer's search (%s)", (rulesetId) => {
    expect(search('consent-occupant-building', rulesetId)).toEqual([['lawful', 'consent']]);
  });

  it.each(['generic', 'strict'])("an occupant's consent to enter does not cover a search of the room (%s)", (rulesetId) => {
    expect(search('consent-occupant-entry-only', rulesetId)).toEqual([['unlawful', null]]);
  });

  it.each(['generic', 'strict'])("another occupant's refusal revokes the consent for the same building only (%s)", (rulesetId) => {
    expect(search('consent-building-revoked', rulesetId)).toEqual([['unlawful', null]]);
    expect(search('consent-other-building-kept', rulesetId)).toEqual([['lawful', 'consent']]);
  });
});
