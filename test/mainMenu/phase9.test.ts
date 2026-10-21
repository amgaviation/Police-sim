import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { officerPreset } from '../../src/gear';
import type { SaveSummary } from '../../src/save/saveManager';
import { defaultCharacter } from '../../src/uniform';
import { MainMenu, TUTORIAL_BUTTON_LABEL, TUTORIAL_RECOMMENDED, visibleSections, type MainMenuCallbacks, type MainMenuCharacter } from '../../src/ui/mainMenu';
import type { UIRoot } from '../../src/ui/ui';
import { FakeElement, fakeUi, findAll, findButton, installFakeDom } from '../ui7/fakeDom';

const base: MainMenuCallbacks = { newGame: () => undefined, continueGame: () => undefined, openSettings: () => undefined };
const save = (slot: string): SaveSummary => ({ slot, officerName: 'Jordan Doe', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, version: 11 });

function withTutorial(seen: unknown[][]): MainMenuCallbacks {
  return { ...base, tutorial: (...a) => void seen.push(a) };
}

describe('MainMenu tutorial (headless)', () => {
  it('the Tutorial section exists only with the callback and comes right after Setup', () => {
    expect(visibleSections(base)).toEqual(['setup', 'freePatrol', 'continue', 'settings']);
    expect(visibleSections(withTutorial([]))).toEqual(['setup', 'tutorial', 'freePatrol', 'continue', 'settings']);
    expect(
      visibleSections({ ...withTutorial([]), newCareer: () => undefined, training: () => undefined, openCoop: () => undefined, openMods: () => undefined }),
    ).toEqual(['setup', 'tutorial', 'career', 'freePatrol', 'training', 'multiplayer', 'mods', 'continue', 'settings']);
    expect(new MainMenu(null, withTutorial([])).sections).toEqual(['setup', 'tutorial', 'freePatrol', 'continue', 'settings']);
  });

  it('old callers keep working: no callback, nothing to start', () => {
    const m = new MainMenu(null, base);
    expect(m.startTutorial()).toBe(false);
    expect(m.tutorialRecommended).toBe(false);
  });

  it('passes the seed box, the jurisdiction and the created officer like New game', () => {
    const seen: unknown[][] = [];
    const m = new MainMenu(null, withTutorial(seen));
    m.seed = '41';
    m.jurisdiction = 'strict';
    expect(m.startTutorial()).toBe(true);
    expect(seen).toEqual([[41, 'strict']]);
    const c: MainMenuCharacter = { profile: defaultCharacter(), gear: officerPreset('patrolStandard') };
    m.setCharacter(c);
    m.seed = 'abc';
    m.startTutorial();
    expect(seen[1]).toEqual(['abc', 'strict', c]);
  });

  it('is recommended exactly while the save list is empty', () => {
    const m = new MainMenu(null, withTutorial([]));
    expect(m.tutorialRecommended).toBe(true);
    m.setSaves([save('autosave')]);
    expect(m.tutorialRecommended).toBe(false);
    m.setSaves([]);
    expect(m.tutorialRecommended).toBe(true);
  });

  it('the existing new-game path is unchanged', () => {
    const games: unknown[][] = [];
    const m = new MainMenu(null, { ...withTutorial([]), newGame: (...a) => void games.push(a) });
    m.seed = '5';
    m.startNewGame();
    expect(games).toEqual([[5, 'generic']]);
  });
});

describe('MainMenu tutorial (DOM double)', () => {
  let undo: () => void = () => undefined;
  beforeAll(() => {
    undo = installFakeDom();
  });
  afterAll(() => undo());

  const headings = (root: FakeElement): string[] => findAll(root, (e) => e.tagName === 'h2').map((h) => h.textContent);

  it('has no Guided first shift button without the callback', () => {
    const root = new MainMenu(fakeUi() as unknown as UIRoot, base).element as unknown as FakeElement;
    expect(findAll(root, (e) => e.tagName === 'button' && e.textContent === TUTORIAL_BUTTON_LABEL)).toHaveLength(0);
    expect(headings(root)).not.toContain('Tutorial');
    expect(root.textContent).not.toContain(TUTORIAL_RECOMMENDED);
  });

  it('shows the section between Setup and Free patrol; the button starts the tutorial', () => {
    const seen: unknown[][] = [];
    const m = new MainMenu(fakeUi() as unknown as UIRoot, withTutorial(seen));
    const root = m.element as unknown as FakeElement;
    expect(headings(root)).toEqual(['Setup', 'Tutorial', 'Free patrol', 'Continue']);
    m.seed = '8';
    findButton(root, 'Guided first shift').click();
    expect(seen).toEqual([[8, 'generic']]);
    expect(TUTORIAL_BUTTON_LABEL).toBe('Guided first shift');
  });

  it('primary with the recommendation while there is no save, plain once there is one', () => {
    const m = new MainMenu(fakeUi() as unknown as UIRoot, withTutorial([]));
    const root = m.element as unknown as FakeElement;
    const button = findButton(root, 'Guided first shift');
    expect(button.className).toBe('primary');
    expect(root.textContent).toContain('Recommended for your first shift');
    m.setSaves([save('autosave'), save('slot2')]);
    expect(button.className).toBe('');
    expect(root.textContent).not.toContain('Recommended for your first shift');
    expect(findButton(root, 'Guided first shift')).toBe(button); // same button, restyled
    m.setSaves([]);
    expect(button.className).toBe('primary');
    expect(root.textContent).toContain('Recommended for your first shift');
  });

  it('New game stays the autofocused primary button and the created officer is passed on', () => {
    const seen: unknown[][] = [];
    const m = new MainMenu(fakeUi() as unknown as UIRoot, withTutorial(seen));
    const root = m.element as unknown as FakeElement;
    expect(findButton(root, 'New game').attrs['autofocus']).toBeDefined();
    const c: MainMenuCharacter = { profile: defaultCharacter(), gear: officerPreset('patrolStandard') };
    m.setCharacter(c);
    findButton(root, 'Guided first shift').click();
    expect(seen).toEqual([[expect.any(Number), 'generic', c]]);
  });
});
