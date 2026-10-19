import { describe, expect, it } from 'vitest';
import { k9Sweep, type K9Target } from '../../src/evidence/k9';
import { createRng } from '../../src/core/rng';

function t(ref: string, room: number, scent: K9Target['scent'], kind: K9Target['kind'] = 'item'): K9Target {
  return { kind, ref, room, x: room * 2, z: room * 3, scent };
}

describe('k9Sweep', () => {
  const always = (): number => 0;
  const never = (): number => 0.999;

  it('visits rooms in order: first at 4 s, then 12 s each', () => {
    const targets = [t('c', 7, 'person', 'person'), t('a', 3, 'narcotics'), t('b', 5, 'firearm')];
    const alerts = k9Sweep([3, 5, 7], targets, always);
    expect(alerts.map((a) => [a.ref, a.atS])).toEqual([['a', 4], ['b', 16], ['c', 28]]);
    expect(alerts[0]).toMatchObject({ kind: 'item', room: 3, x: 6, z: 9 });
    expect(alerts[2]).toMatchObject({ kind: 'person' });
  });
  it('skips rooms that are not visited', () => {
    expect(k9Sweep([1], [t('a', 2, 'person', 'person')], always)).toEqual([]);
    expect(k9Sweep([], [t('a', 2, 'person', 'person')], always)).toEqual([]);
  });
  it('visits a repeated room only once', () => {
    expect(k9Sweep([2, 2], [t('a', 2, 'person', 'person')], always)).toHaveLength(1);
  });
  it('alerts only when u is below the scent probability', () => {
    const targets = [t('p', 1, 'person', 'person'), t('n', 1, 'narcotics'), t('f', 1, 'firearm'), t('o', 1, 'other')];
    const at = (u: number): string[] => k9Sweep([1], targets, () => u).map((a) => a.ref);
    expect(at(0.1)).toEqual(['p', 'n', 'f', 'o']);
    expect(at(0.19)).toEqual(['p', 'n', 'f', 'o']);
    expect(at(0.5)).toEqual(['p', 'n', 'f']);
    expect(at(0.7)).toEqual(['p', 'n']);
    expect(at(0.92)).toEqual(['p']);
    expect(at(0.96)).toEqual([]);
    expect(k9Sweep([1], targets, never)).toEqual([]);
  });
  it('passes the target index to u', () => {
    const seen: number[] = [];
    k9Sweep([1], [t('a', 1, 'person'), t('b', 9, 'person'), t('c', 1, 'person')], (i) => {
      seen.push(i);
      return 0;
    });
    expect(seen).toEqual([0, 2]);
  });
  it('matches the scent odds over many draws', () => {
    const rng = createRng(2024);
    const counts: Record<K9Target['scent'], number> = { person: 0, narcotics: 0, firearm: 0, other: 0 };
    const scents = Object.keys(counts) as K9Target['scent'][];
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const us = scents.map(() => rng.next());
      const alerts = k9Sweep([1], scents.map((s) => t(s, 1, s)), (idx) => us[idx] ?? 1);
      for (const a of alerts) counts[a.ref as K9Target['scent']]++;
    }
    expect(counts.person / n).toBeCloseTo(0.95, 1);
    expect(counts.narcotics / n).toBeCloseTo(0.9, 1);
    expect(counts.firearm / n).toBeCloseTo(0.6, 1);
    expect(counts.other / n).toBeCloseTo(0.2, 1);
  });
});
