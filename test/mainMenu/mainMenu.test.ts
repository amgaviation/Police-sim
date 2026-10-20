import { describe, expect, it } from 'vitest';
import { getRuleset, rulesetIds } from '../../src/legal';
import {
  DEFAULT_JURISDICTION,
  MainMenu,
  jurisdictionOptions,
  normalizeJurisdiction,
  parseSeedInput,
  type MainMenuCallbacks,
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
