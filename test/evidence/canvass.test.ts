import { describe, expect, it } from 'vitest';
import { canvassResult } from '../../src/evidence/canvass';
import { EVIDENCE_DATA, canvassText, sawChanceFor, validateEvidenceData } from '../../src/evidence/data';

describe('canvassResult', () => {
  it('is deterministic', () => {
    for (let b = 0; b < 30; b++) {
      expect(canvassResult(42, 17, b, 12, 0.3)).toEqual(canvassResult(42, 17, b, 12, 0.3));
    }
  });
  it('varies with seed, call and building', () => {
    const results = new Set<string>();
    for (let b = 0; b < 60; b++) results.add(JSON.stringify(canvassResult(42, 17, b, 12, 0.3)));
    expect(results.size).toBeGreaterThan(3);
  });
  it('answers about 75% by day (8..21) and 35% by night', () => {
    let day = 0;
    let night = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      if (canvassResult(7, i, 100 + (i % 50), 12, 0.25).answered) day++;
      if (canvassResult(7, i, 100 + (i % 50), 3, 0.25).answered) night++;
    }
    expect(day / n).toBeGreaterThan(0.71);
    expect(day / n).toBeLessThan(0.79);
    expect(night / n).toBeGreaterThan(0.31);
    expect(night / n).toBeLessThan(0.39);
  });
  it('uses 8 and 21 as the day boundaries', () => {
    const rate = (hour: number): number => {
      let a = 0;
      for (let i = 0; i < 2000; i++) if (canvassResult(3, i, 5, hour, 0.25).answered) a++;
      return a / 2000;
    };
    expect(rate(8)).toBeGreaterThan(0.6);
    expect(rate(21)).toBeGreaterThan(0.6);
    expect(rate(7)).toBeLessThan(0.5);
    expect(rate(22)).toBeLessThan(0.5);
  });
  it('maps results consistently with the answered flag and splits by sawChance', () => {
    const counts = { noAnswer: 0, refused: 0, sawSomething: 0, nothingSeen: 0 };
    let answered = 0;
    for (let i = 0; i < 6000; i++) {
      const r = canvassResult(11, i, 9, 12, 0.4);
      counts[r.result]++;
      expect(r.answered).toBe(r.result !== 'noAnswer');
      expect(r.residentIndex).toBeGreaterThanOrEqual(0);
      expect(r.residentIndex).toBeLessThanOrEqual(2);
      if (r.answered) answered++;
    }
    expect(counts.refused / answered).toBeGreaterThan(0.07);
    expect(counts.refused / answered).toBeLessThan(0.13);
    expect(counts.sawSomething / answered).toBeGreaterThan(0.35);
    expect(counts.sawSomething / answered).toBeLessThan(0.45);
  });
  it('never sees anything with sawChance 0 and always with 1 (when it does not refuse)', () => {
    for (let i = 0; i < 500; i++) {
      expect(canvassResult(5, i, 2, 12, 0).result).not.toBe('sawSomething');
      expect(canvassResult(5, i, 2, 12, 1).result).not.toBe('nothingSeen');
    }
  });
});

describe('evidence data', () => {
  it('loads the shipped table', () => {
    expect(EVIDENCE_DATA.labels.latentPrint).toBe('Latent print');
    expect(sawChanceFor('domestic')).toBe(0.4);
    expect(sawChanceFor('unknownKind')).toBe(0.25);
  });
  it('fills canvass texts', () => {
    expect(canvassText('noAnswer', { address: '12 Oak St' })).toBe('No answer at 12 Oak St.');
    expect(canvassText('sawSomething', { address: '12 Oak St', description: 'a red hatchback', direction: 'north' })).toBe(
      'Resident at 12 Oak St saw a red hatchback heading north.',
    );
  });
  it('rejects bad data naming the field', () => {
    const good = {
      version: 1,
      sawChance: { default: 0.25 },
      canvassTexts: { noAnswer: 'a', nothingSeen: 'b', refused: 'c', sawSomething: 'd {address}' },
      labels: { latentPrint: 'Print' },
    };
    expect(() => validateEvidenceData(good)).not.toThrow();
    expect(() => validateEvidenceData({ ...good, version: 2 })).toThrow(/version/);
    expect(() => validateEvidenceData({ ...good, sawChance: { default: 1.5 } })).toThrow(/sawChance\.default/);
    expect(() => validateEvidenceData({ ...good, sawChance: { other: 0.1 } })).toThrow(/sawChance\.default/);
    expect(() => validateEvidenceData({ ...good, canvassTexts: { ...good.canvassTexts, refused: '' } })).toThrow(/canvassTexts\.refused/);
    expect(() => validateEvidenceData({ ...good, canvassTexts: { ...good.canvassTexts, noAnswer: 'x {bogus}' } })).toThrow(/bogus/);
    expect(() => validateEvidenceData({ ...good, labels: {} })).toThrow(/labels\.latentPrint/);
  });
});
