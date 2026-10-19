import { describe, expect, it } from 'vitest';
import { UNIFORMS, LOADOUT_FIELDS, cycleLoadout, defaultLoadout, isLoadout, uniformColors, uniformLabel } from '../../src/station/locker';

describe('locker', () => {
  it('lists the loadout fields and the four generic uniforms', () => {
    expect(LOADOUT_FIELDS).toEqual(['uniform', 'vest', 'bodycamMount', 'radioAudio', 'flashlight']);
    expect(UNIFORMS.map((u) => u.label)).toEqual(['Long sleeve', 'Short sleeve', 'Jacket', 'Rain gear']);
  });

  it('starts with the first uniform, vest on, chest mount, speaker, handheld light', () => {
    expect(defaultLoadout()).toEqual({ uniform: UNIFORMS[0]?.id, vest: true, bodycamMount: 'chest', radioAudio: 'speaker', flashlight: 'handheld' });
  });

  it('cycles each field without changing the input', () => {
    const l = defaultLoadout();
    const seen = new Set<string>();
    let u = l;
    for (let i = 0; i < UNIFORMS.length; i++) {
      seen.add(u.uniform);
      u = cycleLoadout(u, 'uniform');
    }
    expect(seen.size).toBe(UNIFORMS.length);
    expect(u.uniform).toBe(l.uniform);
    expect(cycleLoadout(l, 'vest').vest).toBe(false);
    expect(cycleLoadout(cycleLoadout(l, 'vest'), 'vest').vest).toBe(true);
    const m1 = cycleLoadout(l, 'bodycamMount');
    const m2 = cycleLoadout(m1, 'bodycamMount');
    const m3 = cycleLoadout(m2, 'bodycamMount');
    expect([m1.bodycamMount, m2.bodycamMount, m3.bodycamMount]).toEqual(['shoulder', 'none', 'chest']);
    expect(cycleLoadout(l, 'radioAudio').radioAudio).toBe('earpiece');
    expect(cycleLoadout(l, 'flashlight').flashlight).toBe('mounted');
    expect(l).toEqual(defaultLoadout());
  });

  it('maps uniforms to generic top and bottom colours', () => {
    const colors = UNIFORMS.map((u) => uniformColors({ ...defaultLoadout(), uniform: u.id }));
    for (const c of colors) {
      expect(c.top).toBeGreaterThanOrEqual(0);
      expect(c.top).toBeLessThanOrEqual(0xffffff);
      expect(c.bottom).toBeLessThanOrEqual(0xffffff);
    }
    expect(new Set(colors.map((c) => c.top)).size).toBe(UNIFORMS.length);
    expect(uniformColors({ ...defaultLoadout(), uniform: 'nope' })).toEqual(colors[0]);
    expect(uniformLabel(defaultLoadout())).toBe('Long sleeve');
  });

  it('validates loadouts', () => {
    expect(isLoadout(defaultLoadout())).toBe(true);
    expect(isLoadout({ ...defaultLoadout(), uniform: 'nope' })).toBe(false);
    expect(isLoadout({ ...defaultLoadout(), vest: 1 })).toBe(false);
    expect(isLoadout({ ...defaultLoadout(), bodycamMount: 'hat' })).toBe(false);
    expect(isLoadout(null)).toBe(false);
  });
});
