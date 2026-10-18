import { describe, expect, it } from 'vitest';
import { DAY, ids, makeRig } from './helpers';

const H = 3600;

describe('daily traits (clothes, daily items)', () => {
  it('do not change at game midnight', () => {
    const r = makeRig(42, 23.9 * H);
    const list = ids(200);
    const before = list.map((id) => {
      const i = r.pop.identity(id);
      return JSON.stringify([i.appearance.top, i.appearance.bottom, i.baseItems]);
    });
    r.clock.t = DAY + 0.1 * H;
    const after = list.map((id) => {
      const i = r.pop.identity(id);
      return JSON.stringify([i.appearance.top, i.appearance.bottom, i.baseItems]);
    });
    expect(after).toEqual(before);
  });

  it('change over at the quiet-hour rollover and are stable within a day', () => {
    const r = makeRig(42, 4.5 * H);
    const list = ids(200);
    const look = (): string[] => list.map((id) => String(r.pop.identity(id).appearance.top) + String(r.pop.identity(id).appearance.bottom));
    const a = look();
    r.clock.t = 5.5 * H;
    const b = look();
    r.clock.t = 20 * H;
    expect(look()).toEqual(b);
    expect(b.filter((x, i) => x !== a[i]).length).toBeGreaterThan(100);
  });
});
