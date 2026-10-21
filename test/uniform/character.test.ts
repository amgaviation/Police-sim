/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- tests mutate loosely typed raw JSON */
import { describe, expect, it } from 'vitest';
import { figureAppearance } from '../../src/uniform/appearance';
import { characterFromLegacy, defaultCharacter, displayName, isCharacterSave, parseCharacter } from '../../src/uniform/character';
import { buildOutfit } from '../../src/uniform/outfit';
import { PRONOUN_PRESETS } from '../../src/uniform/pronouns';
import { SKIN_SHINS } from '../../src/uniform/types';
import type { CharacterProfile } from '../../src/uniform/types';

function variant(edit: (p: any) => void): unknown {
  const p = JSON.parse(JSON.stringify(defaultCharacter())) as Record<string, any>;
  edit(p);
  return p;
}

function errorsOf(json: unknown): string[] {
  const r = parseCharacter(json);
  return r.ok ? [] : r.errors;
}

describe('defaultCharacter', () => {
  it('is Jordan Doe with the documented defaults', () => {
    const c = defaultCharacter();
    expect([c.firstName, c.lastName, c.badge]).toEqual(['Jordan', 'Doe', '4071']);
    expect(c.pronouns).toEqual(PRONOUN_PRESETS.they);
    expect(c.body).toEqual({ heightM: 1.75, build: 1, shoulders: 1, hips: 1 });
    expect([c.skin, c.hairStyle, c.hairColor, c.rank]).toEqual([0xc68e6b, 'short', 0x2a1d14, 'officer']);
    expect(c.outfit.uniform).toBe('classB');
    expect(displayName(c)).toBe('Officer Jordan Doe');
    expect(defaultCharacter()).toEqual(c);
    expect(defaultCharacter().pronouns).not.toBe(c.pronouns);
  });

  it('round trips through JSON and parse', () => {
    const c = defaultCharacter();
    const r = parseCharacter(JSON.parse(JSON.stringify(c)));
    expect(r).toEqual({ ok: true, profile: c });
  });
});

describe('parseCharacter', () => {
  it('accepts range boundaries', () => {
    const lo = variant((p) => (p.body = { heightM: 1.5, build: 0.8, shoulders: 0.85, hips: 0.85 }));
    const hi = variant((p) => (p.body = { heightM: 2.05, build: 1.3, shoulders: 1.2, hips: 1.2 }));
    expect(parseCharacter(lo).ok).toBe(true);
    expect(parseCharacter(hi).ok).toBe(true);
  });

  const bad: [string, (p: any) => void, string][] = [
    ['version', (p) => (p.version = 2), 'version must be 1'],
    ['empty first name', (p) => (p.firstName = ''), 'firstName'],
    ['long last name', (p) => (p.lastName = 'x'.repeat(25)), 'lastName must have 1 to 24 characters'],
    ['digits in name', (p) => (p.firstName = 'R2D2'), 'firstName may only contain letters'],
    ['non-string name', (p) => (p.lastName = 5), 'lastName must be a string'],
    ['short badge', (p) => (p.badge = '12'), 'badge must be 3 to 6 digits'],
    ['letter badge', (p) => (p.badge = '12a45'), 'badge must be 3 to 6 digits'],
    ['tall', (p) => (p.body.heightM = 2.06), 'body.heightM must be a number in [1.5, 2.05]'],
    ['short', (p) => (p.body.heightM = 1.49), 'body.heightM'],
    ['thin', (p) => (p.body.build = 0.79), 'body.build must be a number in [0.8, 1.3]'],
    ['wide shoulders', (p) => (p.body.shoulders = 1.21), 'body.shoulders must be a number in [0.85, 1.2]'],
    ['narrow hips', (p) => (p.body.hips = 0.8), 'body.hips must be a number in [0.85, 1.2]'],
    ['nan', (p) => (p.body.hips = Number.NaN), 'body.hips'],
    ['skin', (p) => (p.skin = 0x1000000), 'skin must be an integer colour'],
    ['hair style', (p) => (p.hairStyle = 'mohawk'), 'hairStyle must be one of'],
    ['hair colour', (p) => (p.hairColor = -1), 'hairColor must be an integer colour'],
    ['rank', (p) => (p.rank = 'general'), 'rank must be one of'],
    ['pronoun id', (p) => (p.pronouns.id = 'xe'), 'pronouns.id must be one of'],
    ['pronoun word', (p) => ((p.pronouns.id = 'custom'), (p.pronouns.subject = 'thirteenletter')), 'pronouns.subject must be 1 to 12 letters'],
    ['pronoun preset mismatch', (p) => (p.pronouns.subject = 'xe'), 'pronouns must match the "they" preset'],
    ['outfit class', (p) => (p.outfit.uniform = 'tuxedo'), 'outfit.uniform must be one of'],
    ['outfit hat', (p) => (p.outfit.hat = 'fez'), 'outfit.hat must be default or one of'],
    ['outfit cold', (p) => (p.outfit.cold = 'default'), 'outfit.cold must be one of'],
    ['outfit plate', (p) => (p.outfit.namePlate = 1), 'outfit.namePlate must be true or false'],
    ['outfit colours', (p) => (p.outfit.colors = { top: 1 }), 'outfit.colors.bottom'],
    ['patch colour', (p) => (p.outfit.patch.base = 1.5), 'outfit.patch.base must be an integer colour'],
    ['patch text', (p) => (p.outfit.patch.text = 'x'.repeat(17)), 'outfit.patch.text must be a string of at most 16'],
    ['patch polygon', (p) => (p.outfit.patch.shape = 'polygon'), 'outfit.patch.points'],
    ['badge shape', (p) => (p.outfit.badge.shape = 'cross'), 'outfit.badge.shape must be one of'],
    ['badge text', (p) => (p.outfit.badge.text = 'x'.repeat(13)), 'outfit.badge.text'],
  ];
  it.each(bad)('rejects a bad %s', (_name, edit, message) => {
    const errors = errorsOf(variant(edit));
    expect(errors.some((e) => e.includes(message))).toBe(true);
  });

  it('rejects non-objects and collects several errors', () => {
    expect(errorsOf(null)).toEqual(['character must be an object']);
    expect(errorsOf([])).toEqual(['character must be an object']);
    const errors = errorsOf(variant((p) => ((p.badge = 'x'), (p.rank = 'y'), (p.skin = 'z'))));
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('trims names and returns a copy', () => {
    const json = variant((p) => ((p.firstName = '  Mary-Ann '), (p.lastName = "O'Neil Jr.")));
    const r = parseCharacter(json);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([r.profile.firstName, r.profile.lastName]).toEqual(['Mary-Ann', "O'Neil Jr."]);
      expect(r.profile.outfit).not.toBe((json as CharacterProfile).outfit);
    }
  });

  it('accepts custom pronouns, a chosen rank and a polygon badge', () => {
    const c = variant((p) => {
      p.pronouns = { id: 'custom', subject: 'xe', object: 'xem', possessive: 'xyr', possessivePronoun: 'xyrs', reflexive: 'xemself', plural: false };
      p.rank = 'captain';
      p.outfit.badge = { shape: 'polygon', points: [[0, 0], [1, 0], [0, 1]], metal: 1, enamel: 2, text: 'X' };
    });
    expect(parseCharacter(c).ok).toBe(true);
  });
});

describe('isCharacterSave', () => {
  it('recognises a valid save only', () => {
    expect(isCharacterSave({ version: 1, profile: defaultCharacter() })).toBe(true);
    expect(isCharacterSave({ version: 2, profile: defaultCharacter() })).toBe(false);
    expect(isCharacterSave({ version: 1, profile: variant((p) => (p.badge = 'x')) })).toBe(false);
    expect(isCharacterSave({ version: 1 })).toBe(false);
    expect(isCharacterSave(null)).toBe(false);
    expect(isCharacterSave('x')).toBe(false);
  });
});

describe('characterFromLegacy', () => {
  it('strips "Officer " and keeps a single word as the last name', () => {
    const c = characterFromLegacy('Officer Doe', '4071');
    expect([c.firstName, c.lastName]).toEqual(['Alex', 'Doe']);
  });

  it('splits at the first space', () => {
    const c = characterFromLegacy('Officer Jane Q. Public', '12345');
    expect([c.firstName, c.lastName, c.badge]).toEqual(['Jane', 'Q. Public', '12345']);
    const d = characterFromLegacy('officer  Sam   Reyes', '999');
    expect([d.firstName, d.lastName, d.badge]).toEqual(['Sam', 'Reyes', '999']);
  });

  it('works without the Officer prefix', () => {
    const c = characterFromLegacy('Kim Lee', '777777');
    expect([c.firstName, c.lastName, c.badge]).toEqual(['Kim', 'Lee', '777777']);
  });

  it('replaces a bad badge and falls back for empty or unusable names', () => {
    expect(characterFromLegacy('Kim Lee', '12').badge).toBe('4071');
    expect(characterFromLegacy('Kim Lee', '1234567').badge).toBe('4071');
    expect(characterFromLegacy('Kim Lee', 'A-12').badge).toBe('4071');
    const e = characterFromLegacy('Officer', '4071');
    expect([e.firstName, e.lastName]).toEqual(['Jordan', 'Doe']);
    const f = characterFromLegacy('', '');
    expect([f.firstName, f.lastName]).toEqual(['Jordan', 'Doe']);
    const g = characterFromLegacy('12345', '4071');
    expect([g.firstName, g.lastName]).toEqual(['Jordan', 'Doe']);
  });

  it('always yields a valid profile', () => {
    for (const name of ['Officer Doe', 'x'.repeat(60), 'A B'.repeat(20), "Zoë O'Brien-Smith", '...', 'Officer  ']) {
      expect(parseCharacter(characterFromLegacy(name, '4071')).ok).toBe(true);
    }
  });
});

describe('displayName and appearance', () => {
  it('uses the rank label above officer', () => {
    const c = defaultCharacter();
    c.rank = 'sergeant';
    expect(displayName(c)).toBe('Sergeant Jordan Doe');
  });

  it('derives the figure appearance', () => {
    const c = defaultCharacter();
    const classB = figureAppearance(c, buildOutfit(c.outfit, { lastName: c.lastName, rank: c.rank }));
    expect(classB).toMatchObject({ skin: 0xc68e6b, hair: 0x2a1d14, top: 0x24375a, bottom: 0x18202e, shins: 0x18202e, height: 1.75, build: 1, shoulders: 1, hips: 1 });

    c.outfit.uniform = 'bike';
    c.body.heightM = 1.9;
    const bike = buildOutfit(c.outfit, { lastName: c.lastName, rank: c.rank });
    expect(bike.shins).toBe(SKIN_SHINS);
    const a = figureAppearance(c, bike);
    expect(a.shins).toBe(c.skin);
    expect(a.hair).toBe(0xffffffff); // bike helmet hides hair
    expect(a.height).toBe(1.9);

    c.outfit.uniform = 'motor';
    c.outfit.hat = 'none';
    expect(figureAppearance(c, buildOutfit(c.outfit, { lastName: 'x', rank: 'officer' })).hair).toBe(c.hairColor);
    c.hairStyle = 'bald';
    expect(figureAppearance(c, buildOutfit(c.outfit, { lastName: 'x', rank: 'officer' })).hair).toBe(0xffffffff);

    const boots = { ...bike, shins: 0x101010 };
    expect(figureAppearance(defaultCharacter(), boots).shins).toBe(0x101010);
  });
});
