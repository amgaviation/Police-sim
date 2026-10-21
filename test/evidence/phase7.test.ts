import { describe, expect, it } from 'vitest';
import { K9_ALERT_CHANCE, K9_FIRST_ROOM_S, K9_ROOM_S, K9_TREAT_BONUS, k9Sweep, type K9Target } from '../../src/evidence';

/** Phase 7 hooks (design §11.4): the treat bonus on the K9 alert chance. */

const target = (scent: K9Target['scent'], room = 0): K9Target => ({ kind: 'item', ref: scent, room, x: 1, z: 2, scent });
const constant = (u: number) => (): number => u;

describe('k9Sweep bonus', () => {
  it('the treat bonus is 0.05', () => {
    expect(K9_TREAT_BONUS).toBe(0.05);
  });

  it('adds the bonus to every scent chance', () => {
    for (const scent of ['person', 'narcotics', 'firearm', 'other'] as const) {
      const chance = K9_ALERT_CHANCE[scent];
      const t = [target(scent)];
      // Just under the plain chance: always alerts; between plain and boosted: only with the bonus.
      expect(k9Sweep([0], t, constant(chance - 0.001))).toHaveLength(1);
      const between = chance + 0.025;
      expect(k9Sweep([0], t, constant(between))).toHaveLength(0);
      expect(k9Sweep([0], t, constant(between), 0.05)).toHaveLength(1);
      expect(k9Sweep([0], t, constant(chance + 0.05 + 0.001), 0.05)).toHaveLength(0);
    }
  });

  it('caps the chance at 0.99', () => {
    const t = [target('person')];
    expect(k9Sweep([0], t, constant(0.985), 0.05)).toHaveLength(1);
    expect(k9Sweep([0], t, constant(0.99), 0.05)).toHaveLength(0);
    expect(k9Sweep([0], t, constant(0.995), 0.5)).toHaveLength(0);
    expect(k9Sweep([0], t, constant(0.98), 0.5)).toHaveLength(1);
  });

  it('omitting the bonus equals bonus 0 and leaves timing and order alone', () => {
    const targets = [target('person', 3), target('narcotics', 5), target('other', 3)];
    const u = (i: number): number => [0.1, 0.5, 0.15][i] ?? 1;
    const plain = k9Sweep([3, 5], targets, u);
    expect(k9Sweep([3, 5], targets, u, 0)).toEqual(plain);
    expect(plain.map((a) => a.ref)).toEqual(['person', 'other', 'narcotics']);
    expect(plain.map((a) => a.atS)).toEqual([K9_FIRST_ROOM_S, K9_FIRST_ROOM_S, K9_FIRST_ROOM_S + K9_ROOM_S]);
    const boosted = k9Sweep([3, 5], targets, u, K9_TREAT_BONUS);
    expect(boosted.map((a) => a.atS)).toEqual(plain.map((a) => a.atS));
  });
});
