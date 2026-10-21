/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- tests mutate loosely typed raw JSON */
import { describe, expect, it } from 'vitest';
import {
  WORLD_CONFIG, isWorldStateSave, newWorldStateSave, type EvolveInput, type WorldRequest, type WorldStateSave,
} from '../../src/worldstate';
import { createRng } from '../../src/core/rng';
import { DAY, T0, call, customWorld, rig, run, scripted, type Rig } from './helpers';

const arrest = (over: Partial<Extract<WorldRequest, { kind: 'arrest' }>> = {}): WorldRequest => ({
  kind: 'arrest', personId: 11, district: 'downtown', callNumber: 'C-0001', x: 5, z: 6, game: T0, offenseClass: 'felony',
  juvenile: false, priors: 0, ...over,
});

const caseOpen = (over: Partial<Extract<WorldRequest, { kind: 'caseOpen' }>> = {}): WorldRequest => ({
  kind: 'caseOpen', callId: 1, number: 'C-0001', typeId: 'burglary', nature: 'Burglary', game: T0, locationText: '1 Main St', x: 1, z: 2,
  suspects: [], witnesses: [], evidence: 0, ...over,
});

function evolveInput(over: Partial<EvolveInput> = {}): EvolveInput {
  return { fromGame: T0, toGame: T0 + 11 * DAY, trust: {}, arrestsByDistrict: {}, addressAt: (u) => `${Math.floor(u * 1000)} Elm Street`, ...over };
}

describe('requests', () => {
  it('are applied in step, not before', () => {
    const r = rig();
    r.world.request({ kind: 'callClosed', call: call() });
    expect(r.world.premiseHistory('1240 N Oak Street')).toEqual([]);
    const rev = r.world.revision;
    r.world.step(1 / 60, { sim: 0, game: 0 });
    expect(r.world.premiseHistory('1240 N Oak Street')).toHaveLength(1);
    expect(r.world.revision).toBeGreaterThan(rev);
  });

  it('an idle step changes nothing', () => {
    const r = rig();
    const rev = r.world.revision;
    r.world.step(1 / 60, { sim: 0, game: 0 });
    expect(r.world.revision).toBe(rev);
  });
});

describe('premise history', () => {
  it('collects two closed calls at one address (case and spacing insensitive) and flags the repeat', () => {
    const r = rig();
    run(
      r,
      { kind: 'callClosed', call: call({ callId: 1, number: 'C-1', text: '1240 N Oak Street', flags: ['weapon'], game: T0 }) },
      { kind: 'callClosed', call: call({ callId: 2, number: 'C-2', text: '1240  n oak street ', typeId: 'noise', nature: 'Noise', flags: ['arrest'], game: T0 + 5 * DAY }) },
    );
    const h = r.world.premiseHistory('1240 N OAK STREET');
    expect(h.map((e) => e.callNumber)).toEqual(['C-1', 'C-2']);
    expect(h[1]?.flags).toEqual(['arrest', 'repeat']);
    expect(r.world.premiseFlags('1240 N Oak Street')).toEqual(['weapon', 'arrest', 'repeat']);
    expect(r.world.premiseHistory('9 Nowhere Rd')).toEqual([]);
    expect(r.world.premiseFlags('9 Nowhere Rd')).toEqual([]);
  });

  it('far apart calls are not flagged repeat', () => {
    const r = rig();
    run(r, { kind: 'callClosed', call: call({ game: T0 }) }, { kind: 'callClosed', call: call({ callId: 2, game: T0 + 60 * DAY }) });
    expect(r.world.premiseFlags('1240 N Oak Street')).toEqual([]);
  });

  it('caps premises and evicts the one with the oldest last entry', () => {
    const r = rig();
    const max = WORLD_CONFIG.premises.max;
    for (let i = 0; i < max; i++) r.world.request({ kind: 'callClosed', call: call({ callId: i, text: `${i + 1} Test Street`, game: T0 + (i + 10) * 100 }) });
    r.world.step(1 / 60, { sim: 0, game: 0 });
    expect(r.world.serialize().premises).toHaveLength(max);
    run(r, { kind: 'callClosed', call: call({ callId: 9999, text: '5000 New Road', game: T0 + 1e6 }) });
    const keys = r.world.serialize().premises.map((p) => p.key);
    expect(keys).toHaveLength(max);
    expect(keys).not.toContain('1 TEST STREET');
    expect(keys).toContain('5000 NEW ROAD');
    expect(keys).toContain('2 TEST STREET');
  });

  it('ignores a blank address', () => {
    const r = rig();
    run(r, { kind: 'callClosed', call: call({ text: '   ' }) });
    expect(r.world.serialize().premises).toEqual([]);
  });
});

describe('offenders and cases', () => {
  it('an arrest creates a jailed offender with a risk and clears the cases of that suspect', () => {
    const r = rig();
    run(r, caseOpen({ callId: 1, suspects: [11] }), caseOpen({ callId: 2, suspects: [12] }), arrest({ priors: 2 }));
    const o = r.world.offender(11);
    expect(o).toMatchObject({ arrests: 1, custody: 'jailed', releaseGame: T0 + DAY, district: 'downtown', convicted: false });
    expect(o?.risk).toBeCloseTo(0.25 + 2 * 0.12);
    expect(r.world.caseOfCall(1)?.status).toBe('cleared');
    expect(r.world.caseOfCall(2)?.status).toBe('open');
    expect(r.events.filter(([t]) => t === 'world:case').map(([, p]) => (p as { status: string }).status)).toEqual(['open', 'open', 'cleared']);
  });

  it('a second arrest counts priors and keeps the conviction in the risk', () => {
    const r = rig();
    run(r, arrest(), { kind: 'verdict', personId: 11, verdict: 'convicted', game: T0 }, arrest({ game: T0 + 20 * DAY }));
    const o = r.world.offender(11);
    expect(o?.arrests).toBe(2);
    expect(o?.convicted).toBe(true);
    expect(o?.risk).toBeCloseTo(0.25 + 0.12 + 0.05);
    expect(o?.custody).toBe('jailed');
  });

  it('a verdict for an unknown person is ignored', () => {
    const r = rig();
    run(r, { kind: 'verdict', personId: 99, verdict: 'convicted', game: T0 });
    expect(r.world.offender(99)).toBeNull();
  });

  it('caps offenders by evicting the earliest release', () => {
    const r = rig();
    const max = WORLD_CONFIG.offenders.max;
    for (let i = 0; i < max; i++) r.world.request(arrest({ personId: i + 1, game: T0 + i * 10 }));
    r.world.step(1 / 60, { sim: 0, game: 0 });
    run(r, arrest({ personId: 5000, game: T0 + 1e6 }));
    expect(r.world.offender(1)).toBeNull();
    expect(r.world.offender(5000)).not.toBeNull();
    expect(r.world.serialize().offenders).toHaveLength(max);
  });

  it('opens cases with sequential ids, once per call, and updates them', () => {
    const r = rig();
    run(r, caseOpen({ callId: 7 }), caseOpen({ callId: 7 }), caseOpen({ callId: 8, number: 'C-8' }));
    expect(r.world.cases().map((c) => c.id)).toEqual(['CS-0001', 'CS-0002']);
    run(r, { kind: 'caseUpdate', callId: 7, game: T0 + 100, suspectsAdd: [3, 3], witnessesAdd: [4], evidenceDelta: 2, status: 'followUp' });
    expect(r.world.caseOfCall(7)).toMatchObject({ suspects: [3], witnesses: [4], evidence: 2, status: 'followUp', lastGame: T0 + 100 });
    expect(r.events.at(-1)).toEqual(['world:case', { caseId: 'CS-0001', callId: 7, status: 'followUp' }]);
    run(r, { kind: 'caseUpdate', callId: 404, game: T0 });
    expect(r.world.caseOfCall(404)).toBeNull();
  });

  it('caps cases by evicting the oldest', () => {
    const r = rig();
    const max = WORLD_CONFIG.cases.max;
    for (let i = 0; i < max; i++) r.world.request(caseOpen({ callId: i + 1, game: T0 + i }));
    r.world.step(1 / 60, { sim: 0, game: 0 });
    run(r, caseOpen({ callId: 5000, game: T0 + 1e6 }));
    expect(r.world.caseOfCall(1)).toBeNull();
    expect(r.world.caseOfCall(5000)?.id).toBe(`CS-${String(max + 1).padStart(4, '0')}`);
    expect(r.world.cases()).toHaveLength(max);
  });
});

describe('recidivism end to end', () => {
  it('arrest -> convicted felony -> jailed 10 days -> evolve 11 days -> released -> picked', () => {
    const r = rig();
    run(r, arrest(), { kind: 'verdict', personId: 11, verdict: 'convicted', game: T0 });
    expect(r.world.offender(11)).toMatchObject({ custody: 'jailed', releaseGame: T0 + 10 * DAY });
    // Jailed: never picked, no draws.
    const jailed = scripted([0, 0]);
    expect(r.world.pickPerson(1, 'downtown', T0 + 5 * DAY, () => true, jailed.draw)).toBe(-1);
    expect(jailed.calls()).toBe(0);

    const result = r.world.evolve(evolveInput());
    expect(result.released).toEqual([11]);
    expect(r.world.offender(11)?.custody).toBe('released');

    const s = scripted([0, 0]);
    expect(r.world.pickPerson(2, 'downtown', T0 + 11 * DAY, () => true, s.draw)).toBe(11);
    expect(r.events.filter(([t]) => t === 'world:recidivist')).toEqual([['world:recidivist', { personId: 11, callId: 2, arrests: 1 }]]);
    // Hostile draws leave the offender alone.
    expect(r.world.pickPerson(3, 'downtown', T0 + 11 * DAY, () => true, scripted([0.99]).draw)).toBe(-1);
  });

  it('a person not released yet by game time is not picked even if evolved', () => {
    const r = rig();
    run(r, arrest(), { kind: 'verdict', personId: 11, verdict: 'convicted', game: T0 });
    r.world.evolve(evolveInput({ toGame: T0 + 5 * DAY }));
    expect(r.world.offender(11)?.custody).toBe('jailed');
  });

  it('an acquittal is released straight away', () => {
    const r = rig();
    run(r, arrest(), { kind: 'verdict', personId: 11, verdict: 'acquitted', game: T0 + 2 });
    expect(r.world.offender(11)).toMatchObject({ custody: 'released', releaseGame: T0 + 2 });
    expect(r.world.pickPerson(1, 'downtown', T0 + 3, () => true, scripted([0, 0]).draw)).toBe(11);
  });

  it('a bound person is returned first, once, and only when it fits', () => {
    const r = rig();
    r.world.bindPerson(40, 77);
    const s = scripted([]);
    expect(r.world.pickPerson(40, 'downtown', T0, () => false, s.draw)).toBe(-1);
    expect(r.world.pickPerson(40, 'downtown', T0, (id) => id === 77, s.draw)).toBe(77);
    expect(r.world.pickPerson(40, 'downtown', T0, () => true, s.draw)).toBe(-1);
    expect(s.calls()).toBe(0);
    expect(r.events.filter(([t]) => t === 'world:recidivist')).toEqual([]);
  });

  it('risk decays by the day over a rollover down to the floor', () => {
    const r = rig();
    run(r, arrest({ priors: 1 }));
    const before = r.world.offender(11)?.risk ?? 0;
    r.world.evolve(evolveInput({ toGame: T0 + 5 * DAY }));
    expect(r.world.offender(11)?.risk).toBeCloseTo(before - 0.05);
    r.world.evolve(evolveInput({ fromGame: T0, toGame: T0 + 30 * DAY }));
    r.world.evolve(evolveInput({ fromGame: T0, toGame: T0 + 30 * DAY }));
    expect(r.world.offender(11)?.risk).toBe(WORLD_CONFIG.offenders.riskMin);
  });
});

describe('witnesses', () => {
  function withWitnesses(n: number): Rig {
    const r = rig(3);
    for (let i = 0; i < n; i++) r.world.request({ kind: 'witness', personId: 100 + i, callId: 1, addressText: `${i} Old Lane` });
    r.world.step(1 / 60, { sim: 0, game: 0 });
    return r;
  }

  it('are upserted, linked to the call case and capped', () => {
    const r = rig();
    run(r, { kind: 'witness', personId: 5, callId: 1, addressText: 'A' }, caseOpen({ callId: 1, witnesses: [5] }));
    run(r, { kind: 'witness', personId: 5, callId: 1, addressText: 'B' }, { kind: 'witness', personId: 6, callId: 1, addressText: 'C' });
    const w = r.world.serialize().witnesses;
    expect(w.map((x) => [x.personId, x.caseId, x.addressText])).toEqual([[5, 'CS-0001', 'B'], [6, 'CS-0001', 'C']]);
    const big = withWitnesses(WORLD_CONFIG.witnesses.max);
    run(big, { kind: 'witness', personId: 9999, callId: 1, addressText: 'New' });
    const ids = big.world.serialize().witnesses.map((x) => x.personId);
    expect(ids).toHaveLength(WORLD_CONFIG.witnesses.max);
    expect(ids).not.toContain(100);
    expect(ids).toContain(9999);
  });

  it('move deterministically over a long gap', () => {
    const run1 = withWitnesses(60).world.evolve(evolveInput({ toGame: T0 + 30 * DAY }));
    const run2 = withWitnesses(60).world.evolve(evolveInput({ toGame: T0 + 30 * DAY }));
    expect(run1.moves).toEqual(run2.moves);
    expect(run1.moves.length).toBeGreaterThan(5);
    expect(run1.moves.some((m) => m.address === null)).toBe(true);
    expect(run1.moves.some((m) => m.address !== null)).toBe(true);
  });

  it('record the new address and the move time; zero days move nobody', () => {
    const r = withWitnesses(60);
    const res = r.world.evolve(evolveInput({ toGame: T0 + 30 * DAY }));
    const moved = res.moves[0];
    const rec = r.world.serialize().witnesses.find((w) => w.personId === moved?.personId);
    expect(rec?.movedGame).toBe(T0 + 30 * DAY);
    expect(rec?.addressText).toBe(moved?.address ?? 'Unknown');
    const still = withWitnesses(60);
    expect(still.world.evolve(evolveInput({ toGame: T0 + DAY - 1 })).moves).toEqual([]);
  });

  it('draw only the stream: addressAt gets a draw in [0, 1)', () => {
    const r = withWitnesses(80);
    const seen: number[] = [];
    r.world.evolve(evolveInput({ toGame: T0 + 30 * DAY, addressAt: (u) => (seen.push(u), 'X') }));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u >= 0 && u < 1)).toBe(true);
  });
});

describe('follow-ups and case aging', () => {
  it('follow-ups need an open case whose suspect is out of custody', () => {
    const w = customWorld({ config: { ...WORLD_CONFIG, cases: { ...WORLD_CONFIG.cases, followUpChance: 1 } } });
    w.request(arrest({ personId: 21, x: 33, z: 44 }));
    w.request({ kind: 'verdict', personId: 21, verdict: 'dismissed', game: T0 });
    w.request(caseOpen({ callId: 1, suspects: [21] }));
    w.request(caseOpen({ callId: 2, suspects: [22] }));
    w.request(caseOpen({ callId: 3, suspects: [23] }));
    w.request(arrest({ personId: 23 }));
    w.step(1 / 60, { sim: 0, game: 0 });
    // Case 3's suspect was arrested after the case opened: cleared. Case 2's suspect is unknown.
    expect(w.cases().map((c) => c.status)).toEqual(['open', 'open', 'cleared']);
    const res = w.evolve(evolveInput());
    expect(res.followUps).toEqual([{ caseId: 'CS-0001', callId: 1, typeId: 'warrantService', personId: 21, x: 33, z: 44 }]);
    expect(w.cases().map((c) => c.status)).toEqual(['followUp', 'open', 'cleared']);
  });

  it('a suspect still in jail gets no follow-up and no draw', () => {
    const w = customWorld({ config: { ...WORLD_CONFIG, cases: { ...WORLD_CONFIG.cases, followUpChance: 1 } } });
    w.request(arrest({ personId: 21, offenseClass: 'felony' }));
    w.request(caseOpen({ callId: 2, suspects: [21] }));
    w.request({ kind: 'verdict', personId: 21, verdict: 'convicted', game: T0 });
    w.step(1 / 60, { sim: 0, game: 0 });
    const before = w.serialize().rng;
    // Under one day: no neighborhood draws either.
    const res = w.evolve(evolveInput({ toGame: T0 + 100 }));
    expect(res.followUps).toEqual([]);
    expect(w.cases().map((c) => c.status)).toEqual(['open']);
    expect(w.serialize().rng).toEqual(before);
  });

  it('follow-up count follows the draws: always chance 1 gives exactly the cap', () => {
    const cfg = { ...WORLD_CONFIG, cases: { ...WORLD_CONFIG.cases, followUpChance: 1 } };
    const w = customWorld({ config: cfg });
    w.request(arrest({ personId: 21 }));
    w.request({ kind: 'verdict', personId: 21, verdict: 'dismissed', game: T0 });
    for (let i = 1; i <= 4; i++) w.request(caseOpen({ callId: i, suspects: [21] }));
    w.step(1 / 60, { sim: 0, game: 0 });
    const res = w.evolve(evolveInput());
    expect(res.followUps).toHaveLength(2);
    expect(res.followUps.map((f) => f.callId)).toEqual([1, 2]);
    expect(res.news.some((n) => n.includes('warrant service'))).toBe(true);
    // The third and fourth stay open and are offered next time.
    expect(w.cases().map((c) => c.status)).toEqual(['followUp', 'followUp', 'open', 'open']);
    const again = w.evolve(evolveInput({ fromGame: T0 + 11 * DAY, toGame: T0 + 12 * DAY }));
    expect(again.followUps.map((f) => f.callId)).toEqual([3, 4]);
  });

  it('cases without a free suspect draw nothing and age until cold', () => {
    const r = rig(5);
    run(r, caseOpen({ callId: 1, suspects: [] }), caseOpen({ callId: 2, suspects: [50] }));
    const before = r.world.serialize().rng;
    for (let i = 0; i < WORLD_CONFIG.cases.coldAfterShifts - 1; i++) {
      r.world.evolve(evolveInput({ toGame: T0, fromGame: T0 }));
    }
    expect(r.world.cases().map((c) => [c.status, c.shiftsOpen])).toEqual([['open', 9], ['open', 9]]);
    expect(r.world.serialize().rng).toEqual(before);
    const res = r.world.evolve(evolveInput({ toGame: T0, fromGame: T0 }));
    expect(r.world.cases().map((c) => c.status)).toEqual(['cold', 'cold']);
    expect(res.news.filter((n) => n.includes('gone cold'))).toHaveLength(2);
    expect(r.events.filter(([t, p]) => t === 'world:case' && (p as { status: string }).status === 'cold')).toHaveLength(2);
    // Cold cases do not age further.
    r.world.evolve(evolveInput({ toGame: T0, fromGame: T0 }));
    expect(r.world.cases().map((c) => c.shiftsOpen)).toEqual([10, 10]);
  });
});

describe('neighborhoods in the world', () => {
  it('start at base, evolve once per day span and report trust deltas and news', () => {
    const r = rig();
    expect(r.world.neighborhood('downtown').crime).toBe(0.6);
    expect(r.world.crimeFactor('downtown')).toBe(1);
    expect(r.world.crimeFactor('nowhere')).toBe(1);
    expect(r.world.neighborhood('nowhere').crime).toBe(0);
    const res = r.world.evolve(evolveInput({ toGame: T0 + 30 * DAY, trust: { downtown: 0.95, suburbs: 0.05 } }));
    expect(res.days).toBe(30);
    expect(r.world.neighborhood('downtown').crime).toBeLessThan(0.6);
    expect(r.world.neighborhood('suburbs').crime).toBeGreaterThan(0.35);
    const dt = res.trustDeltas.find((d) => d.district === 'downtown');
    expect(dt?.delta).toBeGreaterThan(0);
    expect(res.trustDeltas.find((d) => d.district === 'suburbs')?.delta).toBeLessThan(0);
    expect(res.trustDeltas.find((d) => d.district === 'water')).toBeUndefined();
    expect(res.news).toContain('Crime is falling in downtown');
    expect(res.news).toContain('Crime is rising in suburbs');
    expect(r.world.news().map((n) => n.text)).toEqual(res.news);
    expect(r.world.crimeFactor('downtown')).toBeLessThan(1);
  });

  it('clamps the elapsed days to 0..30 and leaves neighborhoods alone for zero days', () => {
    const r = rig();
    expect(r.world.evolve(evolveInput({ toGame: T0 + 400 * DAY })).days).toBe(30);
    const z = rig();
    const before = z.world.serialize();
    const res = z.world.evolve(evolveInput({ toGame: T0 + 100, trust: { downtown: 0 } }));
    expect(res.days).toBe(0);
    expect(z.world.serialize().neighborhoods).toEqual(before.neighborhoods);
    expect(z.world.serialize().rng).toEqual(before.rng);
    expect(z.world.evolve(evolveInput({ toGame: T0 - DAY })).days).toBe(0);
  });

  it('mod base crime changes the starting level and the factor', () => {
    const w = customWorld({ baseCrime: { downtown: 0.3 } });
    expect(w.neighborhood('downtown').crime).toBe(0.3);
    expect(w.neighborhood('suburbs').crime).toBe(0.35);
  });

  it('keeps the news log to 30 lines', () => {
    const r = rig();
    for (let i = 0; i < 50; i++) {
      r.world.request(arrest({ personId: i + 1, game: T0 }));
      r.world.step(1 / 60, { sim: 0, game: 0 });
      r.world.evolve(evolveInput({ fromGame: T0, toGame: T0 + 2 * DAY }));
      r.world.request(arrest({ personId: i + 1, game: T0 + 2 * DAY }));
      r.world.step(1 / 60, { sim: 0, game: 0 });
    }
    expect(r.world.news().length).toBeLessThanOrEqual(30);
  });
});

describe('evolve determinism', () => {
  function busyWorld(): WorldStateSave {
    const r = rig(11);
    for (let i = 0; i < 30; i++) {
      r.world.request(arrest({ personId: i + 1, district: i % 2 === 0 ? 'downtown' : 'harbor', game: T0 }));
      r.world.request({ kind: 'verdict', personId: i + 1, verdict: i % 3 === 0 ? 'convicted' : 'dismissed', game: T0 });
      r.world.request({ kind: 'witness', personId: 200 + i, callId: i, addressText: `${i} Old Rd` });
      r.world.request(caseOpen({ callId: i, suspects: [i + 1] }));
    }
    r.world.step(1 / 60, { sim: 0, game: 0 });
    return r.world.serialize();
  }

  it('evolving twice from the same save gives identical results and states', () => {
    const save = busyWorld();
    const a = rig(11, save);
    const b = rig(99, save);
    const ra = a.world.evolve(evolveInput({ toGame: T0 + 20 * DAY, trust: { downtown: 0.2 } }));
    const rb = b.world.evolve(evolveInput({ toGame: T0 + 20 * DAY, trust: { downtown: 0.2 } }));
    expect(ra).toEqual(rb);
    expect(a.world.serialize()).toEqual(b.world.serialize());
    expect(ra.moves.length).toBeGreaterThan(0);
  });
});

describe('pickRepeatLocation', () => {
  function repeatWorld(): Rig {
    const r = rig();
    run(
      r,
      { kind: 'callClosed', call: call({ text: 'B Street', x: 2, z: 2, callId: 1 }) },
      { kind: 'callClosed', call: call({ text: 'B Street', x: 2, z: 2, callId: 2, game: T0 + 10 }) },
      { kind: 'callClosed', call: call({ text: 'A Street', x: 1, z: 1, callId: 3 }) },
      { kind: 'callClosed', call: call({ text: 'A Street', x: 1, z: 1, callId: 4, game: T0 + 10 }) },
      { kind: 'callClosed', call: call({ text: 'C Street', x: 3, z: 3, callId: 5 }) },
    );
    return r;
  }

  it('returns null without drawing when no premise qualifies', () => {
    const r = rig();
    run(r, { kind: 'callClosed', call: call() });
    const s = scripted([0, 0]);
    expect(r.world.pickRepeatLocation(s.draw)).toBeNull();
    expect(s.calls()).toBe(0);
  });

  it('returns null when the chance draw fails (one draw)', () => {
    const s = scripted([0.2, 0]);
    expect(repeatWorld().world.pickRepeatLocation(s.draw)).toBeNull();
    expect(s.calls()).toBe(1);
  });

  it('picks among qualifying premises sorted by key', () => {
    const r = repeatWorld();
    expect(r.world.pickRepeatLocation(scripted([0.19, 0]).draw)).toEqual({ x: 1, z: 1 });
    expect(r.world.pickRepeatLocation(scripted([0.19, 0.5]).draw)).toEqual({ x: 2, z: 2 });
    expect(r.world.pickRepeatLocation(scripted([0.19, 0.9999]).draw)).toEqual({ x: 2, z: 2 });
    const s = scripted([0.19, 0]);
    r.world.pickRepeatLocation(s.draw);
    expect(s.calls()).toBe(2);
  });

  it('follows new history', () => {
    const r = repeatWorld();
    run(r, { kind: 'callClosed', call: call({ text: 'C Street', x: 3, z: 3, callId: 6, game: T0 + 20 }) });
    expect(r.world.pickRepeatLocation(scripted([0.1, 0.9]).draw)).toEqual({ x: 3, z: 3 });
  });
});

describe('save', () => {
  function populated(): Rig {
    const r = rig(21);
    run(
      r,
      { kind: 'callClosed', call: call({ flags: ['violence'] }) }, { kind: 'callClosed', call: call({ callId: 2, game: T0 + DAY }) },
      arrest(), { kind: 'verdict', personId: 11, verdict: 'convicted', game: T0 },
      caseOpen({ callId: 1, suspects: [12], witnesses: [30] }), { kind: 'witness', personId: 30, callId: 1, addressText: '1 A St' },
    );
    r.world.bindPerson(9, 12);
    r.world.evolve(evolveInput({ toGame: T0 + 12 * DAY, trust: { downtown: 0.9 } }));
    r.world.request(caseOpen({ callId: 5 }));
    return r;
  }

  it('round trips through restore and serialize', () => {
    const r = populated();
    const save = r.world.serialize();
    expect(isWorldStateSave(save)).toBe(true);
    expect(save.queue).toHaveLength(1);
    const other = rig(1);
    other.world.restore(save);
    expect(other.world.serialize()).toEqual(save);
    const fromCtor = rig(2, save);
    expect(fromCtor.world.serialize()).toEqual(save);
    expect(JSON.parse(JSON.stringify(save))).toEqual(save);
    expect(other.world.caseOfCall(1)?.id).toBe('CS-0001');
    expect(other.world.offender(11)?.custody).toBe('released');
    // The restored world keeps simulating identically.
    fromCtor.world.step(1 / 60, { sim: 0, game: 0 });
    r.world.step(1 / 60, { sim: 0, game: 0 });
    expect(fromCtor.world.evolve(evolveInput({ fromGame: T0 + 12 * DAY, toGame: T0 + 30 * DAY }))).toEqual(
      r.world.evolve(evolveInput({ fromGame: T0 + 12 * DAY, toGame: T0 + 30 * DAY })),
    );
  });

  it('serialize does not alias internal state', () => {
    const r = populated();
    const save = r.world.serialize();
    save.offenders.length = 0;
    save.cases.length = 0;
    expect(r.world.offender(11)).not.toBeNull();
    expect(r.world.cases()).toHaveLength(1);
  });

  it('a fresh save validates and starts every district at its base', () => {
    const s = newWorldStateSave(createRng(1).state());
    expect(isWorldStateSave(s)).toBe(true);
    expect(s.neighborhoods.downtown?.crime).toBe(0.6);
    expect(s.neighborhoods.water?.crime).toBe(0);
    expect(newWorldStateSave(createRng(1).state(), { downtown: 0.1 }).neighborhoods.downtown?.crime).toBe(0.1);
  });

  describe('isWorldStateSave rejections', () => {
    const good = (): Record<string, any> => JSON.parse(JSON.stringify(populated().world.serialize())) as Record<string, any>;
    const bad = (edit: (s: Record<string, any>) => void): boolean => {
      const s = good();
      edit(s);
      return isWorldStateSave(s);
    };

    it('accepts the untouched save', () => {
      expect(isWorldStateSave(good())).toBe(true);
    });

    it('rejects non-objects, wrong versions and bad rng', () => {
      expect(isWorldStateSave(null)).toBe(false);
      expect(isWorldStateSave([])).toBe(false);
      expect(bad((s) => { s.version = 2; })).toBe(false);
      expect(bad((s) => { s.rng = { seed: 1, s: [1, 2, 3] }; })).toBe(false);
      expect(bad((s) => { s.rng.s[0] = -1; })).toBe(false);
      expect(bad((s) => { s.lastEvolveGame = 'x'; })).toBe(false);
      expect(bad((s) => { s.nextCase = 0; })).toBe(false);
    });

    it('rejects malformed premises', () => {
      expect(bad((s) => { s.premises = {}; })).toBe(false);
      expect(bad((s) => { s.premises[0].key = 'wrong'; })).toBe(false);
      expect(bad((s) => { s.premises[0].entries[0].flags = ['nope']; })).toBe(false);
      expect(bad((s) => { s.premises[0].entries[0].game = NaN; })).toBe(false);
      expect(bad((s) => { s.premises.push(structuredClone(s.premises[0])); })).toBe(false);
    });

    it('rejects malformed cases', () => {
      expect(bad((s) => { s.cases[0].status = 'closed'; })).toBe(false);
      expect(bad((s) => { s.cases[0].id = 'X-1'; })).toBe(false);
      expect(bad((s) => { s.cases[0].suspects = ['a']; })).toBe(false);
      expect(bad((s) => { s.cases.push(structuredClone(s.cases[0])); })).toBe(false);
      expect(bad((s) => { s.cases[0].shiftsOpen = -1; })).toBe(false);
    });

    it('rejects malformed offenders and witnesses', () => {
      expect(bad((s) => { s.offenders[0].custody = 'free'; })).toBe(false);
      expect(bad((s) => { s.offenders[0].offenseClass = 'crime'; })).toBe(false);
      expect(bad((s) => { s.offenders[0].risk = 2; })).toBe(false);
      expect(bad((s) => { s.offenders[0].convicted = 'yes'; })).toBe(false);
      expect(bad((s) => { s.offenders.push(structuredClone(s.offenders[0])); })).toBe(false);
      expect(bad((s) => { s.witnesses[0].addressText = 5; })).toBe(false);
      expect(bad((s) => { s.witnesses.push(structuredClone(s.witnesses[0])); })).toBe(false);
    });

    it('rejects malformed neighborhoods, bias, news and queue', () => {
      expect(bad((s) => { s.neighborhoods.downtown.crime = 1.5; })).toBe(false);
      expect(bad((s) => { s.neighborhoods.downtown.history = ['a']; })).toBe(false);
      expect(bad((s) => { s.neighborhoods = []; })).toBe(false);
      expect(bad((s) => { s.bias = [[1]]; })).toBe(false);
      expect(bad((s) => { s.bias = [[1, 2.5]]; })).toBe(false);
      expect(bad((s) => { s.news = [{ game: 1 }]; })).toBe(false);
      expect(bad((s) => { s.news = Array.from({ length: 31 }, () => ({ game: 1, text: 'x' })); })).toBe(false);
      expect(bad((s) => { s.queue = [{ kind: 'unknown' }]; })).toBe(false);
      expect(bad((s) => { s.queue[0].callId = 'x'; })).toBe(false);
      expect(bad((s) => { s.queue = [{ kind: 'verdict', personId: 1, verdict: 'hanged', game: 0 }]; })).toBe(false);
      expect(bad((s) => { s.queue = [{ kind: 'caseUpdate', callId: 1, game: 0, status: 'bad' }]; })).toBe(false);
    });

    it('accepts every request kind in the queue', () => {
      const queue: WorldRequest[] = [
        { kind: 'callClosed', call: call() }, arrest(), { kind: 'verdict', personId: 1, verdict: 'plea', game: 0 }, caseOpen(),
        { kind: 'caseUpdate', callId: 1, game: 0, suspectsAdd: [1], status: 'cold' }, { kind: 'witness', personId: 1, callId: 1, addressText: 'x' },
      ];
      expect(bad((s) => { s.queue = queue; })).toBe(true);
    });
  });
});

describe('performance', () => {
  it('idle step, per-request step and a large evolve stay cheap', () => {
    const r = rig(4);
    const t = { sim: 0, game: 0 };
    let start = performance.now();
    for (let i = 0; i < 20000; i++) r.world.step(1 / 60, t);
    expect((performance.now() - start) / 20000).toBeLessThan(0.005);

    for (let i = 0; i < 400; i++) r.world.request({ kind: 'callClosed', call: call({ callId: i, text: `${i} Perf Street`, game: T0 + i }) });
    for (let i = 0; i < 300; i++) r.world.request(arrest({ personId: i + 1, district: i % 2 === 0 ? 'downtown' : 'harbor' }));
    for (let i = 0; i < 200; i++) r.world.request({ kind: 'witness', personId: 1000 + i, callId: i, addressText: 'x' });
    for (let i = 0; i < 100; i++) r.world.request(caseOpen({ callId: i + 1, suspects: [i + 1] }));
    start = performance.now();
    r.world.step(1 / 60, t);
    expect((performance.now() - start) / 1000).toBeLessThan(0.1);

    // Warm up, then time the rollover.
    r.world.evolve(evolveInput({ toGame: T0 + 15 * DAY }));
    start = performance.now();
    r.world.evolve(evolveInput({ fromGame: T0 + 15 * DAY, toGame: T0 + 30 * DAY }));
    expect(performance.now() - start).toBeLessThan(5);
  });
});
