import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { TRIAGE_COLORS, startTriage, transportOrder, victimVitals } from '../../src/command/triage';
import { TRIAGE_TAGS, type TransportCandidate, type Vitals } from '../../src/command/types';

/** Vitals of a stable, non-walking patient who would be `delayed`; tests override single fields. */
function vitals(over: Partial<Vitals> = {}): Vitals {
  return {
    walking: false, breathing: true, breathesAfterAirway: false, respRate: 20, radialPulse: true, capRefillS: 1.5,
    followsCommands: true, trapped: false, contaminated: false, ...over,
  };
}

describe('startTriage (START rules)', () => {
  it('walking patients are minor, whatever else is wrong', () => {
    expect(startTriage(vitals({ walking: true }))).toBe('minor');
    expect(startTriage(vitals({ walking: true, breathing: false, respRate: 0 }))).toBe('minor');
  });

  it('not breathing: immediate when breathing resumes after the airway is opened, else expectant', () => {
    expect(startTriage(vitals({ breathing: false, breathesAfterAirway: true, respRate: 0 }))).toBe('immediate');
    expect(startTriage(vitals({ breathing: false, breathesAfterAirway: false, respRate: 0 }))).toBe('expectant');
  });

  it('respiratory rate above 30 is immediate; exactly 30 is not', () => {
    expect(startTriage(vitals({ respRate: 31 }))).toBe('immediate');
    expect(startTriage(vitals({ respRate: 30 }))).toBe('delayed');
  });

  it('no radial pulse is immediate', () => {
    expect(startTriage(vitals({ radialPulse: false }))).toBe('immediate');
  });

  it('capillary refill above 2 s is immediate; exactly 2 s is not', () => {
    expect(startTriage(vitals({ capRefillS: 2.1 }))).toBe('immediate');
    expect(startTriage(vitals({ capRefillS: 2 }))).toBe('delayed');
  });

  it('not following commands is immediate', () => {
    expect(startTriage(vitals({ followsCommands: false }))).toBe('immediate');
  });

  it('a stable patient who cannot walk is delayed', () => {
    expect(startTriage(vitals())).toBe('delayed');
  });

  it('applies the rules in order: breathing before respiratory rate before perfusion before mental status', () => {
    expect(startTriage(vitals({ breathing: false, respRate: 40, radialPulse: false }))).toBe('expectant');
    expect(startTriage(vitals({ respRate: 40, radialPulse: true, followsCommands: true }))).toBe('immediate');
  });
});

describe('victimVitals', () => {
  const flags = { trapped: false, hazmat: false };

  it('is deterministic per (seed, person) and differs between persons', () => {
    expect(victimVitals(7, 12, 'victim', 1, flags)).toEqual(victimVitals(7, 12, 'victim', 1, flags));
    const all = new Set<string>();
    for (let id = 0; id < 20; id++) all.add(JSON.stringify(victimVitals(7, id, 'victim', 1, flags)));
    expect(all.size).toBeGreaterThan(5);
    expect(JSON.stringify(victimVitals(7, 12, 'victim', 1, flags))).not.toBe(JSON.stringify(victimVitals(8, 12, 'victim', 1, flags)));
  });

  it('draws u1..u6 in order from the vitals stream and follows the formulas', () => {
    for (let id = 1; id <= 30; id++) {
      const rng = createRng(99).stream(`vitals:${id}`);
      const [u1, u2, u3, u4, u5, u6] = [rng.next(), rng.next(), rng.next(), rng.next(), rng.next(), rng.next()] as [number, number, number, number, number, number];
      const sev = Math.min(1, 0.6 + 0.3 * 0.5);
      const v = victimVitals(99, id, 'victim', 0.5, { trapped: true, hazmat: true });
      const breathing = !(sev > 0.9 && u2 < 0.5);
      expect(v.walking).toBe(sev < 0.3 && u1 < 0.9);
      expect(v.breathing).toBe(breathing);
      expect(v.breathesAfterAirway).toBe(!breathing && u3 < 0.4);
      expect(v.respRate).toBe(breathing ? Math.round(12 + sev * 24 + u4 * 6) : 0);
      expect(v.radialPulse).toBe(breathing && !(sev > 0.6 && u5 < 0.5));
      expect(v.capRefillS).toBe(Math.round((1 + sev * 2.5 * u6) * 10) / 10);
      expect(v.followsCommands).toBe(sev < 0.8);
      expect(v.trapped).toBe(sev >= 0.4 && u1 >= 0.5);
      expect(v.contaminated).toBe(true);
    }
  });

  it('role base severities: deceased never breathes, unconscious never follows commands, hazmat only sets contaminated', () => {
    for (let id = 0; id < 50; id++) {
      const dead = victimVitals(3, id, 'deceased', 0, flags);
      expect(dead.breathing).toBe(false);
      expect(dead.breathesAfterAirway).toBe(false);
      expect(dead.respRate).toBe(0);
      expect(dead.followsCommands).toBe(false);
      expect(victimVitals(3, id, 'unconscious', 1, flags).followsCommands).toBe(false);
      expect(victimVitals(3, id, 'victim', 1, flags).contaminated).toBe(false);
      expect(victimVitals(3, id, 'victim', 1, { trapped: false, hazmat: true }).contaminated).toBe(true);
    }
  });

  it('trapped needs the scene flag, enough severity and the draw', () => {
    let trapped = 0;
    for (let id = 0; id < 100; id++) {
      expect(victimVitals(5, id, 'victim', 1, flags).trapped).toBe(false);
      expect(victimVitals(5, id, 'walkingWounded', 0, { trapped: true, hazmat: false }).trapped).toBe(false);
      if (victimVitals(5, id, 'victim', 1, { trapped: true, hazmat: false }).trapped) trapped++;
    }
    expect(trapped).toBeGreaterThan(25);
    expect(trapped).toBeLessThan(75);
  });

  it('START over 100 persons: walking wounded mostly minor; unconscious immediate or expectant; deceased expectant', () => {
    let minor = 0;
    for (let id = 0; id < 100; id++) {
      if (startTriage(victimVitals(11, id, 'walkingWounded', 0, flags)) === 'minor') minor++;
      const tag = startTriage(victimVitals(11, 1000 + id, 'unconscious', 1, flags));
      expect(['immediate', 'expectant']).toContain(tag);
      expect(startTriage(victimVitals(11, 2000 + id, 'deceased', 0, flags))).toBe('expectant');
    }
    expect(minor).toBeGreaterThanOrEqual(80);
    const unconscious = Array.from({ length: 100 }, (_, i) => startTriage(victimVitals(11, 1000 + i, 'unconscious', 1, flags)));
    expect(unconscious.filter((t) => t === 'immediate').length).toBeGreaterThan(40);
    expect(unconscious.filter((t) => t === 'expectant').length).toBeGreaterThan(10);
  });

  it('injured victims are mostly red or yellow, never green', () => {
    for (let id = 0; id < 100; id++) {
      expect(startTriage(victimVitals(21, id, 'victim', 1, flags))).not.toBe('minor');
      expect(['delayed', 'immediate', 'expectant']).toContain(startTriage(victimVitals(21, id, 'victim', 0, flags)));
    }
  });
});

describe('transportOrder', () => {
  const row = (personId: number, tag: TransportCandidate['tag'], over: Partial<TransportCandidate> = {}): TransportCandidate => ({
    personId, tag, transported: false, trapped: false, contaminated: false, ...over,
  });

  it('sorts immediate, delayed, minor, then person id', () => {
    const order = transportOrder([row(5, 'minor'), row(9, 'immediate'), row(2, 'delayed'), row(7, 'immediate'), row(1, 'minor'), row(3, 'delayed')]);
    expect(order).toEqual([7, 9, 2, 3, 1, 5]);
  });

  it('never includes expectant, untagged, transported, trapped or contaminated patients', () => {
    const order = transportOrder([
      row(1, 'expectant'), row(2, null), row(3, 'immediate', { transported: true }), row(4, 'immediate', { trapped: true }),
      row(5, 'delayed', { contaminated: true }), row(6, 'minor'),
    ]);
    expect(order).toEqual([6]);
    expect(transportOrder([])).toEqual([]);
  });
});

describe('TRIAGE_COLORS', () => {
  it('has the four tag colours', () => {
    expect(TRIAGE_COLORS).toEqual({ minor: '#3a9d4a', delayed: '#d8b31a', immediate: '#c8322b', expectant: '#202020' });
    expect(Object.keys(TRIAGE_COLORS).sort()).toEqual([...TRIAGE_TAGS].sort());
  });
});
