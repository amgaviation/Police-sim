import { describe, expect, it } from 'vitest';
import { ETA_CONFIG, parseEtaConfig } from '../../src/units/data';
import {
  airEta,
  estimateResponse,
  expectedSpeed,
  rankByEta,
  remainingEta,
  urgencyFor,
  type EtaCandidate,
} from '../../src/units/eta';
import type { EtaInput } from '../../src/units/types';

function input(over: Partial<EtaInput> = {}): EtaInput {
  return {
    routeTimeS: 100,
    routeLengthM: 1000,
    priority: 1,
    urgency: 'emergency',
    trafficDensity: 0,
    wetness: 0,
    turnoutS: [30, 120],
    speedFactor: 1,
    ...over,
  };
}

describe('urgencyFor', () => {
  it('maps P1-P2 to emergency, P3 to respond, P4 to routine', () => {
    expect([1, 2, 3, 4].map((p) => urgencyFor(p as 1 | 2 | 3 | 4))).toEqual(['emergency', 'emergency', 'respond', 'routine']);
  });
});

describe('ETA config', () => {
  it('ships the design values and rejects bad variants', () => {
    expect(ETA_CONFIG).toEqual({
      urgencyFactor: { routine: 0.9, respond: 1.05, emergency: 1.35 },
      trafficPenalty: { routine: 0.45, respond: 0.35, emergency: 0.15 },
      wetPenalty: 0.15,
      minTravelS: 5,
      rankCandidates: 4,
    });
    const bad = (mutate: (j: Record<string, unknown>) => void): unknown => {
      const j = structuredClone(ETA_CONFIG) as unknown as Record<string, unknown>;
      j.version = 1;
      mutate(j);
      return j;
    };
    expect(() => parseEtaConfig(bad((j) => (j.rankCandidates = 0)), 'bad.json')).toThrow(/^bad\.json: rankCandidates must be in \[1, 64\]/);
    expect(() => parseEtaConfig(bad((j) => (j.rankCandidates = 2.5)), 'bad.json')).toThrow(/^bad\.json: rankCandidates must be an integer/);
    expect(() => parseEtaConfig(bad((j) => delete j.urgencyFactor), 'bad.json')).toThrow(/^bad\.json: urgencyFactor must be an object/);
    expect(() => parseEtaConfig(bad((j) => ((j.trafficPenalty as Record<string, number>).respond = -1)), 'bad.json')).toThrow(
      /^bad\.json: trafficPenalty\.respond must be in/,
    );
    expect(() => parseEtaConfig(bad((j) => (j.extra = 1)), 'bad.json')).toThrow(/^bad\.json: extra is not one of/);
  });
});

describe('estimateResponse', () => {
  it('interpolates the turnout by priority (P1 / P2 / P3 / P4)', () => {
    const turnout = (priority: 1 | 2 | 3 | 4): number => estimateResponse(input({ priority })).turnoutS;
    expect(turnout(1)).toBe(30);
    expect(turnout(2)).toBe(60);
    expect(turnout(3)).toBe(90);
    expect(turnout(4)).toBe(120);
  });

  it('adds turnout and travel; emergency is faster than respond faster than routine', () => {
    const r = estimateResponse(input());
    expect(r.travelS).toBeCloseTo(100 / 1.35, 10);
    expect(r.etaS).toBeCloseTo(30 + 100 / 1.35, 10);
    const e = estimateResponse(input({ urgency: 'emergency' })).travelS;
    const s = estimateResponse(input({ urgency: 'respond' })).travelS;
    const q = estimateResponse(input({ urgency: 'routine' })).travelS;
    expect(e).toBeCloseTo(100 / 1.35, 10);
    expect(s).toBeCloseTo(100 / 1.05, 10);
    expect(q).toBeCloseTo(100 / 0.9, 10);
    expect(e).toBeLessThan(s);
    expect(s).toBeLessThan(q);
  });

  it('scales travel by 1 + penalty * density (density 0 vs 2, clamped to 0..2)', () => {
    const t = (urgency: 'emergency' | 'respond' | 'routine', trafficDensity: number): number =>
      estimateResponse(input({ urgency, trafficDensity })).travelS;
    expect(t('emergency', 2) / t('emergency', 0)).toBeCloseTo(1 + 0.15 * 2, 10);
    expect(t('respond', 2) / t('respond', 0)).toBeCloseTo(1 + 0.35 * 2, 10);
    expect(t('routine', 2) / t('routine', 0)).toBeCloseTo(1 + 0.45 * 2, 10);
    expect(t('respond', 5)).toBeCloseTo(t('respond', 2), 10);
    expect(t('respond', -3)).toBeCloseTo(t('respond', 0), 10);
    expect(t('respond', 1) / t('respond', 0)).toBeCloseTo(1.35, 10);
  });

  it('scales travel by 1 + 0.15 * wetness (clamped to 0..1)', () => {
    const t = (wetness: number): number => estimateResponse(input({ wetness })).travelS;
    expect(t(1) / t(0)).toBeCloseTo(1.15, 10);
    expect(t(0.5) / t(0)).toBeCloseTo(1.075, 10);
    expect(t(4)).toBeCloseTo(t(1), 10);
    expect(t(-1)).toBeCloseTo(t(0), 10);
  });

  it('floors the travel at minTravelS', () => {
    const r = estimateResponse(input({ routeTimeS: 1, routeLengthM: 20 }));
    expect(r.travelS).toBe(5);
    expect(r.etaS).toBe(35);
  });

  it('a zero-length route is the turnout only', () => {
    const r = estimateResponse(input({ routeTimeS: 0, routeLengthM: 0, priority: 2 }));
    expect(r).toEqual({ etaS: 60, turnoutS: 60, travelS: 0 });
  });

  it('a slower speed factor (0.85) lengthens the travel', () => {
    const a = estimateResponse(input()).travelS;
    const b = estimateResponse(input({ speedFactor: 0.85 })).travelS;
    expect(b / a).toBeCloseTo(1 / 0.85, 10);
    expect(b).toBeGreaterThan(a);
  });

  it('combines all factors multiplicatively (exact number)', () => {
    const r = estimateResponse(input({ urgency: 'respond', priority: 3, trafficDensity: 1.5, wetness: 0.6, speedFactor: 0.85 }));
    const travel = (100 / (1.05 * 0.85)) * (1 + 0.35 * 1.5) * (1 + 0.15 * 0.6);
    expect(r.turnoutS).toBe(90);
    expect(r.travelS).toBeCloseTo(travel, 10);
    expect(r.etaS).toBeCloseTo(90 + travel, 10);
  });

  it('throws a RangeError on non-finite inputs and bad priorities', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => estimateResponse(input({ routeTimeS: bad }))).toThrow(RangeError);
      expect(() => estimateResponse(input({ routeLengthM: bad }))).toThrow(RangeError);
      expect(() => estimateResponse(input({ trafficDensity: bad }))).toThrow(RangeError);
      expect(() => estimateResponse(input({ wetness: bad }))).toThrow(RangeError);
      expect(() => estimateResponse(input({ speedFactor: bad }))).toThrow(RangeError);
      expect(() => estimateResponse(input({ turnoutS: [bad, 10] }))).toThrow(RangeError);
    }
    expect(() => estimateResponse(input({ priority: 5 as 4 }))).toThrow(RangeError);
  });
});

describe('airEta', () => {
  it('is distance / speed plus the interpolated turnout', () => {
    const r = airEta(4500, 45, [60, 180], 1);
    expect(r).toEqual({ etaS: 160, turnoutS: 60, travelS: 100 });
    expect(airEta(900, 45, [60, 180], 4)).toEqual({ etaS: 200, turnoutS: 180, travelS: 20 });
    expect(airEta(0, 45, [60, 180], 2).etaS).toBe(100);
  });

  it('rejects non-finite values and a non-positive speed', () => {
    expect(() => airEta(NaN, 45, [60, 180], 1)).toThrow(RangeError);
    expect(() => airEta(100, 0, [60, 180], 1)).toThrow(RangeError);
    expect(() => airEta(100, 45, [NaN, 180], 1)).toThrow(RangeError);
  });
});

describe('remainingEta / expectedSpeed', () => {
  it('returns -1 without a route, divides otherwise and floors the speed at 1 m/s', () => {
    expect(remainingEta(-1, 10)).toBe(-1);
    expect(remainingEta(500, 10)).toBe(50);
    expect(remainingEta(0, 10)).toBe(0);
    expect(remainingEta(30, 0.2)).toBe(30);
    expect(remainingEta(30, 0)).toBe(30);
  });

  it('expectedSpeed is length / max(1, travel)', () => {
    expect(expectedSpeed(1000, 100)).toBe(10);
    expect(expectedSpeed(1000, 0.25)).toBe(1000);
    expect(expectedSpeed(0, 50)).toBe(0);
  });
});

describe('rankByEta', () => {
  const make = (route: { timeS: number; lengthM: number }) =>
    estimateResponse({
      routeTimeS: route.timeS,
      routeLengthM: route.lengthM,
      priority: 1,
      urgency: 'emergency',
      trafficDensity: 0,
      wetness: 0,
      turnoutS: [10, 10],
      speedFactor: 1,
    });

  it('prefers a farther unit with a fast route over a nearer one with a slow route', () => {
    const cands: EtaCandidate[] = [
      { id: 'near', x: 100, z: 0 },
      { id: 'far', x: 400, z: 0 },
    ];
    const routes: Record<string, { timeS: number; lengthM: number }> = {
      near: { timeS: 300, lengthM: 900 },
      far: { timeS: 50, lengthM: 600 },
    };
    const out = rankByEta(cands, 0, 0, (c) => routes[c.id] ?? null, (_c, r) => make(r));
    expect(out.map((r) => r.id)).toEqual(['far', 'near']);
    expect(out[0]).toEqual({ id: 'far', etaS: 10 + 50 / 1.35, distanceM: 400, routeLengthM: 600 });
    expect(out[1]?.distanceM).toBe(100);
  });

  it('drops unreachable units (route null)', () => {
    const cands: EtaCandidate[] = [
      { id: 'a', x: 10, z: 0 },
      { id: 'b', x: 20, z: 0 },
    ];
    const out = rankByEta(cands, 0, 0, (c) => (c.id === 'a' ? null : { timeS: 10, lengthM: 100 }), (_c, r) => make(r));
    expect(out.map((r) => r.id)).toEqual(['b']);
    expect(rankByEta(cands, 0, 0, () => null, (_c, r) => make(r))).toEqual([]);
    expect(rankByEta([], 0, 0, () => null, (_c, r) => make(r))).toEqual([]);
  });

  it('prefilters to the 4 nearest by straight line: the 5th is never routed', () => {
    const cands: EtaCandidate[] = [500, 100, 300, 200, 400].map((d) => ({ id: `u${d}`, x: d, z: 0 }));
    const asked: string[] = [];
    const out = rankByEta(
      cands,
      0,
      0,
      (c) => {
        asked.push(c.id);
        return { timeS: 10, lengthM: 100 };
      },
      (_c, r) => make(r),
    );
    expect(asked).toEqual(['u100', 'u200', 'u300', 'u400']);
    expect(asked).not.toContain('u500');
    expect(out).toHaveLength(4);
  });

  it('honours a custom rankCandidates', () => {
    const cfg = parseEtaConfig({ ...structuredClone(ETA_CONFIG), version: 1, rankCandidates: 1 }, 'x.json');
    let calls = 0;
    const cands: EtaCandidate[] = [1, 2, 3].map((d) => ({ id: `u${d}`, x: d, z: 0 }));
    rankByEta(cands, 0, 0, () => (calls++, { timeS: 1, lengthM: 1 }), (_c, r) => make(r), cfg);
    expect(calls).toBe(1);
  });

  it('breaks ties deterministically: eta, then distance, then id (input order does not matter)', () => {
    const route = { timeS: 40, lengthM: 400 };
    const a: EtaCandidate[] = [
      { id: 'c', x: 0, z: 50 },
      { id: 'b', x: 50, z: 0 },
      { id: 'a', x: 0, z: -50 },
      { id: 'd', x: 30, z: 0 },
    ];
    const reversed = [...a].reverse();
    const r1 = rankByEta(a, 0, 0, () => route, (_c, r) => make(r));
    const r2 = rankByEta(reversed, 0, 0, () => route, (_c, r) => make(r));
    expect(r1.map((r) => r.id)).toEqual(['d', 'a', 'b', 'c']);
    expect(r2).toEqual(r1);
  });

  it('prefilter ties (equal distance) are broken by id ascending', () => {
    const cands: EtaCandidate[] = ['e', 'd', 'c', 'b', 'a'].map((id) => ({ id, x: 100, z: 0 }));
    const asked: string[] = [];
    rankByEta(cands, 0, 0, (c) => (asked.push(c.id), { timeS: 10, lengthM: 10 }), (_c, r) => make(r));
    expect(asked).toEqual(['a', 'b', 'c', 'd']);
  });

  it('propagates a RangeError from the estimator on NaN', () => {
    const cands: EtaCandidate[] = [{ id: 'a', x: 1, z: 1 }];
    expect(() => rankByEta(cands, 0, 0, () => ({ timeS: NaN, lengthM: 10 }), (_c, r) => make(r))).toThrow(RangeError);
  });
});
