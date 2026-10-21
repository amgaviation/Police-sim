import { describe, expect, it } from 'vitest';
import { OutfitTable } from '../../src/game/phase7';
import { buildOutfit, defaultOutfitSpec } from '../../src/uniform/outfit';
import { badgeSize, namePlateBox, shapedPatchBox } from '../../src/uniform/parts';

const ctx = { lastName: 'Vale', rank: 'officer' } as const;

describe('OutfitTable', () => {
  it('gives outfits that differ only in patch, badge or hair colour their own rows', () => {
    const table = new OutfitTable();
    const base = defaultOutfitSpec('classB');
    const a = table.intern(buildOutfit(base, ctx));
    expect(table.intern(buildOutfit(base, ctx))).toBe(a);
    const patch = { ...base, patch: { ...base.patch, base: 0xff0000 } };
    const badge = { ...base, badge: { ...base.badge, metal: 0x00ff00 } };
    const rows = new Set([a, table.intern(buildOutfit(patch, ctx)), table.intern(buildOutfit(badge, ctx))]);
    expect(rows.size).toBe(3);
    const long = { ...base, hairStyle: 'long' as const, hairColor: 0x2a1d14 };
    const l1 = table.intern(buildOutfit(long, ctx));
    const l2 = table.intern(buildOutfit({ ...long, hairColor: 0xff00ff }, ctx));
    expect(l1).not.toBe(l2);
    expect(table.defs[l2]?.boxes.some((b) => b.color === 0xff00ff)).toBe(true);
  });

  it('frees a released row once nobody holds it and reuses it, replacing the defs array', () => {
    const table = new OutfitTable();
    const base = defaultOutfitSpec('classB');
    const first = table.intern(buildOutfit(base, ctx));
    const shared = table.intern(buildOutfit(base, ctx));
    expect(shared).toBe(first);
    table.release(first);
    expect(table.defs[first]).not.toBeNull();
    const before = table.defs;
    table.release(first);
    expect(table.defs).not.toBe(before);
    expect(table.defs[first]).toBeNull();
    const red = table.intern(buildOutfit({ ...base, patch: { ...base.patch, base: 0xff0000 } }, ctx));
    expect(red).toBe(first);
    expect(table.defs).toHaveLength(2);
    // Releasing row 0 or an unknown row is harmless.
    table.release(0);
    table.release(99);
    expect(table.defs[red]).not.toBeNull();
  });
});

describe('emblem footprints on the figure', () => {
  it('sizes the patch by its shape and the badge by its shape', () => {
    expect(shapedPatchBox(1, 'circle').sy).toBe(0.08);
    expect(shapedPatchBox(1, 'roundedRect').sz).toBeGreaterThan(shapedPatchBox(1, 'roundedRect').sy);
    expect(shapedPatchBox(-1, 'shield').sz).toBe(0.07);
    const wide = shapedPatchBox(1, 'polygon', [[0, 0], [2, 0], [2, 1], [0, 1]]);
    const tall = shapedPatchBox(1, 'polygon', [[0, 0], [1, 0], [1, 2], [0, 2]]);
    expect(wide.sz).toBeGreaterThan(tall.sz);
    expect(badgeSize('ellipse').w).toBeGreaterThan(badgeSize('ellipse').h);
    expect(badgeSize('star')).toEqual({ w: 0.06, h: 0.07 });
    expect(badgeSize('circle')).toEqual({ w: 0.065, h: 0.065 });
  });

  it('draws them in the outfit: an ellipse badge, a circle patch and a name plate as wide as the name', () => {
    const spec = defaultOutfitSpec('classB');
    spec.badge = { ...spec.badge, shape: 'ellipse' };
    spec.patch = { ...spec.patch, shape: 'circle' };
    const def = buildOutfit(spec, ctx);
    expect(def.boxes.some((b) => b.sx === 0.075 && b.sy === 0.055)).toBe(true);
    expect(def.boxes.filter((b) => b.sy === 0.08 && b.sz === 0.08)).toHaveLength(2);
    expect(namePlateBox('Vale').sx).toBeLessThan(namePlateBox('Vandenberghe').sx);
    expect(namePlateBox('A very long surname indeed').sx).toBe(0.09);
    const short = buildOutfit(spec, { lastName: 'Li', rank: 'officer' });
    const long = buildOutfit(spec, { lastName: 'Vandenberghe', rank: 'officer' });
    expect(short.boxes.length).toBe(long.boxes.length);
    expect(short.boxes).not.toEqual(long.boxes);
  });
});
