import { describe, expect, it } from 'vitest';
import { WORLD_CONFIG, addPremiseEntry, premiseFlagsFor, premiseKey, type PremiseEntry, type PremiseRecord } from '../../src/worldstate';
import { DAY, T0 } from './helpers';

function premise(): PremiseRecord {
  return { key: '1 MAIN ST', text: '1 Main St', x: 0, z: 0, edge: 0, district: 'downtown', entries: [] };
}

function entry(game: number, n = 1): PremiseEntry {
  return { game, callNumber: `C-${n}`, typeId: 't', nature: 'n', disposition: 'report', flags: [] };
}

const base = { disposition: 'report', category: 'theft', familyId: null, weaponSeen: false, forceUsed: false, officerInjured: false, drugsFound: false };

describe('premiseKey', () => {
  it('upper-cases, trims and collapses whitespace', () => {
    expect(premiseKey('1240 n oak  street')).toBe('1240 N OAK STREET');
    expect(premiseKey('  1240\tN   Oak Street \n')).toBe('1240 N OAK STREET');
    expect(premiseKey('')).toBe('');
  });
});

describe('premiseFlagsFor', () => {
  it('has no flags for a quiet call', () => {
    expect(premiseFlagsFor(base)).toEqual([]);
  });

  it('maps each input to its flag', () => {
    expect(premiseFlagsFor({ ...base, disposition: 'arrestMade' })).toEqual(['arrest']);
    expect(premiseFlagsFor({ ...base, weaponSeen: true })).toEqual(['weapon']);
    for (const category of ['assault', 'domestic', 'robbery']) expect(premiseFlagsFor({ ...base, category })).toEqual(['violence']);
    expect(premiseFlagsFor({ ...base, forceUsed: true })).toEqual(['officerSafety']);
    expect(premiseFlagsFor({ ...base, officerInjured: true })).toEqual(['officerSafety']);
    expect(premiseFlagsFor({ ...base, category: 'dui' })).toEqual(['drugs']);
    expect(premiseFlagsFor({ ...base, drugsFound: true })).toEqual(['drugs']);
    expect(premiseFlagsFor({ ...base, familyId: 'crisis' })).toEqual(['mentalHealth']);
    expect(premiseFlagsFor({ ...base, familyId: 'welfare' })).toEqual([]);
  });

  it('lists several flags in the canonical order', () => {
    const f = premiseFlagsFor({
      disposition: 'arrestMade', category: 'assault', familyId: 'crisis', weaponSeen: true, forceUsed: true, officerInjured: false, drugsFound: true,
    });
    expect(f).toEqual(['weapon', 'violence', 'arrest', 'officerSafety', 'drugs', 'mentalHealth']);
  });
});

describe('addPremiseEntry', () => {
  it('appends newest last and caps the list', () => {
    const p = premise();
    const cap = WORLD_CONFIG.premises.entriesPerPremise;
    for (let i = 0; i < cap + 5; i++) addPremiseEntry(p, entry(T0 + i * 100 * DAY, i));
    expect(p.entries).toHaveLength(cap);
    expect(p.entries[0]?.callNumber).toBe('C-5');
    expect(p.entries[cap - 1]?.callNumber).toBe(`C-${cap + 4}`);
  });

  it('flags repeat when the threshold is reached inside the window', () => {
    const p = premise();
    const first = entry(T0, 1);
    addPremiseEntry(p, first);
    expect(first.flags).not.toContain('repeat');
    const second = entry(T0 + 29 * DAY, 2);
    addPremiseEntry(p, second);
    expect(second.flags).toContain('repeat');
  });

  it('does not flag repeat outside the window', () => {
    const p = premise();
    addPremiseEntry(p, entry(T0, 1));
    const late = entry(T0 + 31 * DAY, 2);
    addPremiseEntry(p, late);
    expect(late.flags).not.toContain('repeat');
  });

  it('honours a custom threshold and does not duplicate the flag', () => {
    const cfg = { ...WORLD_CONFIG.premises, repeatThreshold: 3 };
    const p = premise();
    const a = entry(T0, 1);
    const b = entry(T0 + DAY, 2);
    const c = { ...entry(T0 + 2 * DAY, 3), flags: ['repeat' as const] };
    addPremiseEntry(p, a, cfg);
    addPremiseEntry(p, b, cfg);
    expect(b.flags).toEqual([]);
    addPremiseEntry(p, c, cfg);
    expect(c.flags).toEqual(['repeat']);
  });
});
