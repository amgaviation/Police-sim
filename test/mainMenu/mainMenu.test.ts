import { describe, expect, it } from 'vitest';
import { officerPreset } from '../../src/gear';
import { getRuleset, rulesetIds } from '../../src/legal';
import { PRONOUN_PRESETS, defaultCharacter } from '../../src/uniform';
import {
  DEFAULT_JURISDICTION,
  MainMenu,
  jurisdictionOptions,
  officerSummary,
  normalizeJurisdiction,
  parseSeedInput,
  type MainMenuCallbacks,
  type MainMenuCharacter,
} from '../../src/ui/mainMenu';

interface Calls {
  newGame: [number | string, string | undefined][];
  changed: string[];
}

function menu(): { menu: MainMenu; calls: Calls } {
  const calls: Calls = { newGame: [], changed: [] };
  const callbacks: MainMenuCallbacks = {
    newGame: (seed, jurisdiction) => calls.newGame.push([seed, jurisdiction]),
    continueGame: () => undefined,
    openSettings: () => undefined,
    jurisdictionChanged: (id) => calls.changed.push(id),
  };
  return { menu: new MainMenu(null, callbacks), calls };
}

describe('jurisdiction select model', () => {
  it('lists every ruleset with its display name, sorted by id, and defaults to generic', () => {
    const options = jurisdictionOptions();
    expect(options.map((o) => o.id)).toEqual(rulesetIds());
    expect(options.length).toBeGreaterThanOrEqual(2);
    for (const o of options) expect(o.name).toBe(getRuleset(o.id).name);
    expect(options.map((o) => o.id)).toContain('generic');
    expect(options.map((o) => o.id)).toContain('strict');
    expect(DEFAULT_JURISDICTION).toBe('generic');
    expect(new Set(options.map((o) => o.name)).size).toBe(options.length);
  });

  it('normalizes unknown, empty and missing ids to the default', () => {
    expect(normalizeJurisdiction('strict')).toBe('strict');
    expect(normalizeJurisdiction('generic')).toBe('generic');
    expect(normalizeJurisdiction('nope')).toBe('generic');
    expect(normalizeJurisdiction('')).toBe('generic');
    expect(normalizeJurisdiction(null)).toBe('generic');
    expect(normalizeJurisdiction(undefined)).toBe('generic');
  });
});

describe('MainMenu (headless)', () => {
  it('constructs without a DOM and starts on the generic jurisdiction', () => {
    const { menu: m } = menu();
    expect(m.id).toBe('main');
    expect(m.jurisdiction).toBe('generic');
    expect(m.seed).toBe('');
    m.setSaves([]);
    m.setStatus('hello');
    expect(m.statusLine).toBe('hello');
    m.open();
    m.close();
  });

  it('passes the seed and the default jurisdiction to the new game callback', () => {
    const { menu: m, calls } = menu();
    m.seed = '1234';
    m.startNewGame();
    expect(calls.newGame).toEqual([[1234, 'generic']]);
    m.seed = 'tuesday';
    m.startNewGame();
    expect(calls.newGame[1]).toEqual(['tuesday', 'generic']);
  });

  it('passes a preselected jurisdiction, and falls back to the default for unknown ids', () => {
    const { menu: m, calls } = menu();
    m.seed = '7';
    m.jurisdiction = 'strict';
    expect(m.jurisdiction).toBe('strict');
    m.startNewGame();
    expect(calls.newGame).toEqual([[7, 'strict']]);
    m.jurisdiction = 'bogus';
    expect(m.jurisdiction).toBe('generic');
    expect(calls.changed).toEqual([]); // preselecting is silent
  });

  it('keeps the old one-argument callback shape working', () => {
    const seen: (number | string)[] = [];
    const legacy: MainMenuCallbacks = { newGame: (seed) => seen.push(seed), continueGame: () => undefined, openSettings: () => undefined };
    const m = new MainMenu(null, legacy);
    m.seed = '99';
    m.startNewGame();
    expect(seen).toEqual([99]);
  });

  it('swallows Escape on the title screen', () => {
    const { menu: m } = menu();
    expect(m.onKeyDown({ key: 'Escape' } as KeyboardEvent)).toBe(true);
    expect(m.onKeyDown({ key: 'a' } as KeyboardEvent)).toBe(false);
  });
});

describe('parseSeedInput', () => {
  it('reads integers as numbers, text as text, blank as a random number', () => {
    expect(parseSeedInput(' 42 ')).toBe(42);
    expect(parseSeedInput('-5')).toBe(-5);
    expect(parseSeedInput('abc')).toBe('abc');
    expect(typeof parseSeedInput('')).toBe('number');
  });
});

describe('MainMenu officer (Phase 7)', () => {
  const officer = (): MainMenuCharacter => ({ profile: defaultCharacter(), gear: officerPreset('patrolStandard') });

  it('old callers that take two arguments keep working: no third argument without an officer', () => {
    const seen: unknown[][] = [];
    const callbacks: MainMenuCallbacks = {
      newGame: (...args: unknown[]) => void seen.push(args),
      continueGame: () => undefined,
      openSettings: () => undefined,
    };
    const m = new MainMenu(null, callbacks);
    m.seed = '5';
    m.startNewGame();
    expect(seen).toEqual([[5, 'generic']]);
    expect(m.character).toBeNull();
  });

  it('passes the created officer as the third argument, until it is cleared', () => {
    const seen: unknown[][] = [];
    const callbacks: MainMenuCallbacks = {
      newGame: (seed, jurisdiction, character) => void seen.push([seed, jurisdiction, character]),
      continueGame: () => undefined,
      openSettings: () => undefined,
    };
    const m = new MainMenu(null, callbacks);
    const c = officer();
    m.seed = '9';
    m.setCharacter(c);
    expect(m.character).toBe(c);
    m.startNewGame();
    expect(seen).toEqual([[9, 'generic', c]]);
    m.setCharacter(null);
    m.startNewGame();
    expect(seen[1]).toEqual([9, 'generic', undefined]);
  });

  it('summarises the officer with name and pronouns', () => {
    expect(officerSummary(officer())).toBe('Officer: Jordan Doe (they/them)');
    const she = officer();
    she.profile.firstName = 'Ana';
    she.profile.pronouns = { ...PRONOUN_PRESETS.she };
    expect(officerSummary(she)).toBe('Officer: Ana Doe (she/her)');
  });

  it('cannot open the creator headless', () => {
    const { menu: m } = menu();
    expect(m.createOfficer()).toBeNull();
  });
});
