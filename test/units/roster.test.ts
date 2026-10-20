import { describe, expect, it } from 'vitest';
import { NAMES } from '../../src/records/data';
import { ROSTER_CONFIG, parseRosterConfig } from '../../src/units/data';
import { mistakeChances, officerName, officerProfile, rollMistakes } from '../../src/units/personality';
import { RosterState, emptyRosterSave, isRosterSave } from '../../src/units/roster';
import { ROSTER_EVENTS, type OfficerDynamic, type OfficerTraits, type RosterSave } from '../../src/units/types';

const SEED = 42;

const calm: OfficerTraits = { aggression: 0.4, discipline: 0.6, experience: 0.5, composure: 0.6, communication: 0.6 };
function dyn(over: Partial<OfficerDynamic> = {}): OfficerDynamic {
  return { stress: 0.2, fatigue: 0.2, loyalty: 0.5, calls: 0, mistakes: 0, arrivals: 0, ...over };
}
function config(mutate: (j: Record<string, unknown>) => void): ReturnType<typeof parseRosterConfig> {
  const j = structuredClone(ROSTER_CONFIG) as unknown as Record<string, unknown>;
  j.version = 1;
  mutate(j);
  return parseRosterConfig(j, 'x.json');
}

describe('officer profile', () => {
  it('is identical for the same seed and callsign, different across callsigns and seeds', () => {
    const a = officerProfile(SEED, '21', 'officer');
    expect(officerProfile(SEED, '21', 'officer')).toEqual(a);
    expect(officerProfile(SEED, '23', 'officer')).not.toEqual(a);
    expect(officerProfile(SEED + 1, '21', 'officer')).not.toEqual(a);
    const names = new Set(['21', '23', '25', '27', '31', '33'].map((c) => officerProfile(SEED, c, 'officer').name));
    expect(names.size).toBeGreaterThan(3);
  });

  it('keeps the traits inside the configured ranges', () => {
    for (let i = 0; i < 200; i++) {
      const p = officerProfile(SEED, `U${i}`, 'officer');
      for (const k of Object.keys(ROSTER_CONFIG.traits) as (keyof OfficerTraits)[]) {
        const [lo, hi] = ROSTER_CONFIG.traits[k];
        expect(p.traits[k]).toBeGreaterThanOrEqual(lo);
        expect(p.traits[k]).toBeLessThan(hi);
      }
      expect(p.height).toBeGreaterThanOrEqual(1.62);
      expect(p.height).toBeLessThanOrEqual(1.95);
    }
  });

  it('names come from NAMES and use the rank titles', () => {
    const o = officerName(SEED, '21', 'officer');
    expect(o.name).toBe(`Officer ${o.first.charAt(0)}. ${o.last}`);
    expect([...NAMES.male, ...NAMES.female]).toContain(o.first);
    expect(NAMES.last).toContain(o.last);
    expect(officerName(SEED, 'SGT-1', 'sergeant').name.startsWith('Sgt. ')).toBe(true);
    expect(officerName(SEED, 'LT-1', 'lieutenant').name.startsWith('Lt. ')).toBe(true);
    expect(officerName(SEED, 'CHIEF-1', 'chief').name.startsWith('Chief ')).toBe(true);
    // the name draws come first, so the profile carries the same name
    const p = officerProfile(SEED, '21', 'officer');
    expect(p.name).toBe(o.name);
    expect(p.first).toBe(o.first);
    expect(p.last).toBe(o.last);
  });
});

describe('mistakeChances', () => {
  it('matches the formula exactly', () => {
    const c = mistakeChances(calm, dyn({ stress: 0.5, fatigue: 0.4, loyalty: 0.5 }));
    const w = ROSTER_CONFIG.mistakes.lateCallout;
    const expected =
      w.base + 0.5 * w.stress + 0.4 * w.fatigue + 0.5 * w.loyalty + 0.5 * w.experience + 0.6 * w.discipline + 0.6 * w.composure;
    expect(c.lateCallout).toBeCloseTo(expected, 12);
    const f = ROSTER_CONFIG.mistakes.excessiveForce;
    expect(c.excessiveForce).toBeCloseTo(f.base + 0.5 * f.stress + 0.4 * f.fatigue + 0.4 * f.aggression + 0.6 * f.discipline + 0.6 * f.composure, 12);
  });

  it('rises with stress and fatigue', () => {
    let prev = mistakeChances(calm, dyn({ stress: 0 }));
    for (const s of [0.25, 0.5, 0.75, 1]) {
      const next = mistakeChances(calm, dyn({ stress: s }));
      expect(next.lateCallout).toBeGreaterThan(prev.lateCallout);
      expect(next.poorPosition).toBeGreaterThan(prev.poorPosition);
      expect(next.excessiveForce).toBeGreaterThan(prev.excessiveForce);
      prev = next;
    }
    const lo = mistakeChances(calm, dyn({ fatigue: 0 }));
    const hi = mistakeChances(calm, dyn({ fatigue: 1 }));
    expect(hi.lateCallout).toBeGreaterThan(lo.lateCallout);
    expect(hi.poorPosition).toBeGreaterThan(lo.poorPosition);
    expect(hi.excessiveForce).toBeGreaterThan(lo.excessiveForce);
  });

  it('falls with experience and discipline; excessive force rises with aggression', () => {
    const base = mistakeChances(calm, dyn());
    const exp = mistakeChances({ ...calm, experience: 0.95 }, dyn());
    expect(exp.lateCallout).toBeLessThan(base.lateCallout);
    expect(exp.poorPosition).toBeLessThan(base.poorPosition);
    const dis = mistakeChances({ ...calm, discipline: 0.95 }, dyn());
    expect(dis.lateCallout).toBeLessThan(base.lateCallout);
    expect(dis.poorPosition).toBeLessThan(base.poorPosition);
    expect(dis.excessiveForce).toBeLessThan(base.excessiveForce);
    expect(mistakeChances({ ...calm, aggression: 0.8 }, dyn()).excessiveForce).toBeGreaterThan(base.excessiveForce);
  });

  it('is clamped to 0 and to maxChance', () => {
    const maxed: OfficerTraits = { aggression: 1, discipline: 0, experience: 0, composure: 0, communication: 0 };
    const top = mistakeChances(maxed, dyn({ stress: 1, fatigue: 1, loyalty: 0 }));
    expect(top.excessiveForce).toBe(ROSTER_CONFIG.maxChance.excessiveForce);
    const cfg = config((j) => {
      j.maxChance = { lateCallout: 0.1, poorPosition: 0.1, excessiveForce: 0.01 };
    });
    const capped = mistakeChances(maxed, dyn({ stress: 1, fatigue: 1, loyalty: 0 }), cfg);
    expect(capped).toEqual({ lateCallout: 0.1, poorPosition: 0.1, excessiveForce: 0.01 });
    const best: OfficerTraits = { aggression: 0, discipline: 1, experience: 1, composure: 1, communication: 1 };
    const floor = mistakeChances(best, dyn({ stress: 0, fatigue: 0, loyalty: 1 }));
    expect(floor.lateCallout).toBe(0);
    expect(floor.poorPosition).toBe(0);
    expect(floor.excessiveForce).toBe(0);
  });
});

describe('rollMistakes', () => {
  const chances = { lateCallout: 0.3, poorPosition: 0.3, excessiveForce: 0.3 };

  it('is deterministic per seed, callsign and seq', () => {
    for (let seq = 1; seq <= 20; seq++) {
      expect(rollMistakes(SEED, '21', seq, chances)).toEqual(rollMistakes(SEED, '21', seq, chances));
    }
  });

  it('hits at about the chance over 200 sequences', () => {
    for (const kind of ['lateCallout', 'poorPosition', 'excessiveForce'] as const) {
      let hits = 0;
      for (let seq = 1; seq <= 200; seq++) if (rollMistakes(SEED, '21', seq, chances)[kind]) hits++;
      expect(hits / 200).toBeGreaterThanOrEqual(0.2);
      expect(hits / 200).toBeLessThanOrEqual(0.4);
    }
  });

  it('differs between seeds and between callsigns', () => {
    const half = { lateCallout: 0.5, poorPosition: 0.5, excessiveForce: 0.5 };
    let seedDiff = 0;
    let callsignDiff = 0;
    for (let seq = 1; seq <= 50; seq++) {
      const a = rollMistakes(1, '21', seq, half);
      if (JSON.stringify(a) !== JSON.stringify(rollMistakes(2, '21', seq, half))) seedDiff++;
      if (JSON.stringify(a) !== JSON.stringify(rollMistakes(1, '23', seq, half))) callsignDiff++;
    }
    expect(seedDiff).toBeGreaterThan(0);
    expect(callsignDiff).toBeGreaterThan(0);
  });

  it('always hits at chance 1 and never at chance 0, and draws independently per kind', () => {
    expect(rollMistakes(SEED, '21', 1, { lateCallout: 1, poorPosition: 1, excessiveForce: 1 })).toEqual({
      lateCallout: true,
      poorPosition: true,
      excessiveForce: true,
    });
    expect(rollMistakes(SEED, '21', 1, { lateCallout: 0, poorPosition: 0, excessiveForce: 0 })).toEqual({
      lateCallout: false,
      poorPosition: false,
      excessiveForce: false,
    });
    // lowering a later kind's chance never changes an earlier kind's outcome (fixed draw order)
    for (let seq = 1; seq <= 40; seq++) {
      const a = rollMistakes(SEED, '21', seq, chances);
      const b = rollMistakes(SEED, '21', seq, { ...chances, excessiveForce: 0 });
      expect(b.lateCallout).toBe(a.lateCallout);
      expect(b.poorPosition).toBe(a.poorPosition);
    }
  });
});

describe('RosterState', () => {
  it('ensure adds the officer with start values and a loyalty inside its range', () => {
    const r = new RosterState(SEED);
    const rev = r.revision;
    const p = r.ensure('21', 'officer');
    expect(p).toEqual(officerProfile(SEED, '21', 'officer'));
    expect(r.revision).toBeGreaterThan(rev);
    const d = r.dynamic('21');
    expect(d?.stress).toBe(ROSTER_CONFIG.stress.start);
    expect(d?.fatigue).toBe(ROSTER_CONFIG.fatigue.start);
    expect(d?.loyalty).toBeGreaterThanOrEqual(0.4);
    expect(d?.loyalty).toBeLessThanOrEqual(0.7);
    expect(d).toMatchObject({ calls: 0, mistakes: 0, arrivals: 0 });
    expect(r.ensure('21', 'sergeant')).toBe(p);
    expect(r.profile('21')).toBe(p);
    expect(r.profile('nope')).toBeNull();
    expect(r.dynamic('nope')).toBeNull();
    r.ensure('23', 'officer');
    expect(r.callsigns()).toEqual(['21', '23']);
    // the start loyalty is deterministic per seed and callsign
    const r2 = new RosterState(SEED);
    r2.ensure('23', 'officer');
    r2.ensure('21', 'officer');
    expect(r2.dynamic('21')?.loyalty).toBe(r.dynamic('21')?.loyalty);
  });

  it('applyEvent applies the data deltas and clamps to 0..1', () => {
    const r = new RosterState(SEED);
    r.ensure('21', 'officer');
    const loyalty0 = r.dynamic('21')?.loyalty ?? 0;
    r.applyEvent('21', 'shotsFired');
    expect(r.dynamic('21')?.stress).toBeCloseTo(0.1 + 0.45, 12);
    r.applyEvent('21', 'shotsFired');
    r.applyEvent('21', 'officerInjured');
    expect(r.dynamic('21')?.stress).toBe(1);
    r.applyEvent('21', 'abandoned');
    expect(r.dynamic('21')?.loyalty).toBeCloseTo(loyalty0 - 0.04, 12);
    for (let i = 0; i < 20; i++) r.applyEvent('21', 'intervenedOnThem');
    expect(r.dynamic('21')?.loyalty).toBe(0);
    for (let i = 0; i < 40; i++) r.applyEvent('21', 'coveredByPlayer');
    expect(r.dynamic('21')?.loyalty).toBe(1);
    for (let i = 0; i < 40; i++) r.applyEvent('21', 'callHandled');
    expect(r.dynamic('21')?.stress).toBe(0);
    r.applyEvent('missing', 'fight');
  });

  it('callHandled adds fatigue and counts the call', () => {
    const r = new RosterState(SEED);
    r.ensure('21', 'officer');
    r.applyEvent('21', 'callHandled');
    r.applyEvent('21', 'callHandled');
    expect(r.dynamic('21')?.calls).toBe(2);
    expect(r.dynamic('21')?.fatigue).toBeCloseTo(0.05 + 2 * 0.015, 12);
    expect(r.dynamic('21')?.stress).toBe(0);
    r.applyEvent('21', 'fight');
    expect(r.dynamic('21')?.calls).toBe(2);
  });

  it('every roster event has a delta', () => {
    const r = new RosterState(SEED);
    r.ensure('21', 'officer');
    for (const e of ROSTER_EVENTS) {
      const before = r.revision;
      r.applyEvent('21', e);
      expect(r.revision).toBeGreaterThan(before);
    }
  });

  it('nextArrival counts up and noteMistake counts mistakes', () => {
    const r = new RosterState(SEED);
    r.ensure('21', 'officer');
    expect([r.nextArrival('21'), r.nextArrival('21'), r.nextArrival('21')]).toEqual([1, 2, 3]);
    r.noteMistake('21');
    expect(r.dynamic('21')).toMatchObject({ arrivals: 3, mistakes: 1 });
    expect(r.nextArrival('nope')).toBe(0);
  });

  it('stepMinutes decays stress by composure and adds fatigue per hour', () => {
    const r = new RosterState(SEED);
    // find a calm and a rattled officer
    const ids = Array.from({ length: 40 }, (_, i) => `U${i}`);
    for (const id of ids) r.ensure(id, 'officer');
    const sorted = [...ids].sort((a, b) => (r.profile(a)?.traits.composure ?? 0) - (r.profile(b)?.traits.composure ?? 0));
    const rattled = sorted[0] as string;
    const steady = sorted[sorted.length - 1] as string;
    for (const id of [rattled, steady]) {
      r.applyEvent(id, 'shotsFired');
      r.applyEvent(id, 'shotsFired');
    }
    const before = r.dynamic(rattled)?.stress ?? 0;
    r.stepMinutes(5);
    const dr = before - (r.dynamic(rattled)?.stress ?? 0);
    const ds = before - (r.dynamic(steady)?.stress ?? 0);
    expect(dr).toBeCloseTo(0.03 * (0.5 + (r.profile(rattled)?.traits.composure ?? 0)) * 5, 10);
    expect(ds).toBeCloseTo(0.03 * (0.5 + (r.profile(steady)?.traits.composure ?? 0)) * 5, 10);
    expect(ds).toBeGreaterThan(dr);
    expect(r.dynamic(rattled)?.fatigue).toBeCloseTo(0.05 + (0.06 / 60) * 5, 12);
    r.stepMinutes(10000);
    expect(r.dynamic(rattled)?.stress).toBe(0);
    expect(r.dynamic(rattled)?.fatigue).toBe(1);
    const rev = r.revision;
    r.stepMinutes(0);
    expect(r.revision).toBe(rev);
  });

  it('startShift resets stress and fatigue and keeps loyalty and counters', () => {
    const r = new RosterState(SEED);
    r.ensure('21', 'officer');
    r.applyEvent('21', 'shotsFired');
    r.applyEvent('21', 'callHandled');
    r.applyEvent('21', 'coveredByPlayer');
    r.stepMinutes(120);
    const loyalty = r.dynamic('21')?.loyalty;
    r.startShift();
    expect(r.dynamic('21')).toMatchObject({ stress: 0.1, fatigue: 0.05, loyalty, calls: 1 });
  });

  it('serialize -> restore round trip keeps the state and rebuilds the profiles', () => {
    const r = new RosterState(SEED);
    r.ensure('21', 'officer');
    r.ensure('SGT-1', 'sergeant');
    r.applyEvent('21', 'shotsFired');
    r.applyEvent('21', 'callHandled');
    r.nextArrival('21');
    r.noteMistake('SGT-1');
    r.stepMinutes(30);
    const save = r.serialize();
    expect(isRosterSave(save)).toBe(true);
    expect(isRosterSave(JSON.parse(JSON.stringify(save)))).toBe(true);
    const r2 = new RosterState(SEED);
    r2.ensure('stale', 'officer');
    r2.restore(JSON.parse(JSON.stringify(save)) as RosterSave);
    expect(r2.serialize()).toEqual(save);
    expect(r2.callsigns()).toEqual(['21', 'SGT-1']);
    expect(r2.profile('21')).toEqual(r.profile('21'));
    expect(r2.profile('SGT-1')?.name.startsWith('Sgt. ')).toBe(true);
    expect(r2.profile('stale')).toBeNull();
    expect(save.officers[0]).not.toHaveProperty('traits');
  });

  it('restore clamps out-of-range values', () => {
    const r = new RosterState(SEED);
    r.restore({ version: 1, officers: [{ callsign: '21', rank: 'officer', stress: 5, fatigue: 5, loyalty: -1, calls: 2.7, mistakes: -3, arrivals: 1 }] });
    expect(r.dynamic('21')).toEqual({ stress: 1, fatigue: 1, loyalty: 0, calls: 2, mistakes: 0, arrivals: 1 });
  });

  it('stepMinutes over 30 officers stays cheap (loop by index, no iterators)', () => {
    const r = new RosterState(SEED);
    for (let i = 0; i < 30; i++) r.ensure(`U${i}`, 'officer');
    r.stepMinutes(1);
    const t = performance.now();
    for (let i = 0; i < 1000; i++) r.stepMinutes(1);
    const perCallUs = ((performance.now() - t) * 1000) / 1000;
    expect(perCallUs).toBeLessThan(50);
  });
});

describe('isRosterSave / emptyRosterSave', () => {
  const good = {
    version: 1,
    officers: [{ callsign: '21', rank: 'officer', stress: 0.2, fatigue: 0.1, loyalty: 0.5, calls: 1, mistakes: 0, arrivals: 2 }],
  };

  it('accepts the empty save and a good one', () => {
    expect(emptyRosterSave()).toEqual({ version: 1, officers: [] });
    expect(isRosterSave(emptyRosterSave())).toBe(true);
    expect(isRosterSave(good)).toBe(true);
  });

  it('rejects malformed input', () => {
    const withOfficer = (patch: Record<string, unknown>): unknown => ({ version: 1, officers: [{ ...good.officers[0], ...patch }] });
    const bad: unknown[] = [
      null,
      undefined,
      42,
      'x',
      [],
      {},
      { version: 2, officers: [] },
      { version: 1 },
      { version: 1, officers: {} },
      { version: 1, officers: [null] },
      withOfficer({ callsign: '' }),
      withOfficer({ callsign: 21 }),
      withOfficer({ rank: 'captain' }),
      withOfficer({ stress: 1.5 }),
      withOfficer({ fatigue: -0.1 }),
      withOfficer({ loyalty: NaN }),
      withOfficer({ loyalty: '0.5' }),
      withOfficer({ calls: 1.5 }),
      withOfficer({ mistakes: -1 }),
      withOfficer({ arrivals: undefined }),
      { version: 1, officers: [good.officers[0], good.officers[0]] },
    ];
    for (const b of bad) expect(isRosterSave(b)).toBe(false);
  });
});
