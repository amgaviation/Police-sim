import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { officerPreset } from '../../src/gear';
import { defaultCharacter } from '../../src/uniform';
import {
  MainMenu,
  NO_SCRIPT_LABEL,
  TRAINING_KINDS,
  TRAINING_LABELS,
  visibleSections,
  type MainMenuCallbacks,
  type MainMenuCharacter,
  type TrainingKind,
} from '../../src/ui/mainMenu';
import type { UIRoot } from '../../src/ui/ui';
import { FakeElement, fakeUi, findAll, findButton, installFakeDom } from '../ui7/fakeDom';

const base: MainMenuCallbacks = { newGame: () => undefined, continueGame: () => undefined, openSettings: () => undefined };

interface Log {
  career: unknown[][];
  training: [TrainingKind, string | undefined][];
  coop: number;
  mods: number;
}

function full(log: Log, scripts = [{ id: 'friday-night', name: 'Friday night' }, { id: 'quiet-weekday', name: 'Quiet weekday' }]): MainMenuCallbacks {
  return {
    ...base,
    newCareer: (...a) => void log.career.push(a),
    training: (...a: [TrainingKind, string?]) => void log.training.push([a[0], a[1]]),
    openCoop: () => void log.coop++,
    openMods: () => void log.mods++,
    scripts: () => scripts,
    modSummary: () => '2 mods active',
  };
}

const newLog = (): Log => ({ career: [], training: [], coop: 0, mods: 0 });

describe('MainMenu Phase 8 callbacks (headless)', () => {
  it('shows only the sections whose callbacks exist', () => {
    expect(visibleSections(base)).toEqual(['setup', 'freePatrol', 'continue', 'settings']);
    expect(visibleSections(full(newLog()))).toEqual(['setup', 'career', 'freePatrol', 'training', 'multiplayer', 'mods', 'continue', 'settings']);
    expect(visibleSections({ ...base, openMods: () => undefined })).toEqual(['setup', 'freePatrol', 'mods', 'continue', 'settings']);
    expect(new MainMenu(null, base).sections).toEqual(['setup', 'freePatrol', 'continue', 'settings']);
  });

  it('old callers keep working: nothing new is available without the callbacks', () => {
    const m = new MainMenu(null, base);
    expect(m.trainingKinds).toEqual([]);
    expect(m.scriptOptions).toEqual([]);
    expect(m.modSummaryText).toBe('');
    expect(m.startNewCareer()).toBe(false);
    expect(m.startTraining('drills')).toBe(false);
    expect(m.openMultiplayer()).toBe(false);
    expect(m.openModManager()).toBe(false);
  });

  it('starts a career with the seed box, the jurisdiction and the created officer', () => {
    const log = newLog();
    const m = new MainMenu(null, full(log));
    m.seed = '77';
    m.jurisdiction = 'strict';
    expect(m.startNewCareer()).toBe(true);
    expect(log.career).toEqual([[77, 'strict']]);
    const c: MainMenuCharacter = { profile: defaultCharacter(), gear: officerPreset('patrolStandard') };
    m.setCharacter(c);
    m.startNewCareer();
    expect(log.career[1]).toEqual([77, 'strict', c]);
  });

  it('lists every training button and passes the kind', () => {
    const log = newLog();
    const m = new MainMenu(null, full(log));
    expect(m.trainingKinds).toEqual([...TRAINING_KINDS]);
    for (const kind of ['drills', 'report', 'driving', 'sandbox'] as const) m.startTraining(kind);
    expect(log.training).toEqual([['drills', undefined], ['report', undefined], ['driving', undefined], ['sandbox', undefined]]);
    expect(TRAINING_LABELS.dispatch).toBe('Dispatch-only');
  });

  it('dispatch-only passes the picked script, nothing for "no script", and ignores an unknown script', () => {
    const log = newLog();
    const m = new MainMenu(null, full(log));
    expect(m.scriptOptions.map((s) => s.id)).toEqual(['friday-night', 'quiet-weekday']);
    m.startTraining('dispatch');
    m.script = 'friday-night';
    expect(m.script).toBe('friday-night');
    m.startTraining('dispatch');
    m.script = 'not-a-script';
    expect(m.script).toBe('');
    m.script = 'quiet-weekday';
    m.startTraining('dispatch', 'multi-alarm'); // an explicit option wins
    expect(log.training).toEqual([['dispatch', undefined], ['dispatch', 'friday-night'], ['dispatch', 'multi-alarm']]);
  });

  it('opens the lobby and the mod manager and reports the mod summary', () => {
    const log = newLog();
    const m = new MainMenu(null, full(log));
    expect(m.openMultiplayer()).toBe(true);
    expect(m.openModManager()).toBe(true);
    expect(log.coop).toBe(1);
    expect(log.mods).toBe(1);
    expect(m.modSummaryText).toBe('2 mods active');
  });

  it('the existing new-game path is unchanged', () => {
    const seen: unknown[][] = [];
    const m = new MainMenu(null, { ...full(newLog()), newGame: (...a) => void seen.push(a) });
    m.seed = '5';
    m.startNewGame();
    expect(seen).toEqual([[5, 'generic']]);
  });
});

describe('MainMenu Phase 8 (DOM double)', () => {
  let undo: () => void = () => undefined;
  beforeAll(() => {
    undo = installFakeDom();
  });
  afterAll(() => undo());

  const labels = (root: FakeElement): string[] => findAll(root, (e) => e.tagName === 'button').map((b) => b.textContent);

  it('hides the Career, Training, Multiplayer and Mods buttons without their callbacks', () => {
    const m = new MainMenu(fakeUi() as unknown as UIRoot, base);
    const root = m.element as unknown as FakeElement;
    const all = labels(root);
    for (const hidden of ['New career', 'Academy drills', 'Report writing', 'Driving academy', 'Dispatch-only', 'Scenario editor', 'Co-op lobby…', 'Manage mods…']) {
      expect(all).not.toContain(hidden);
    }
    expect(all).toContain('New game');
    expect(all).toContain('Create officer…');
    expect(all).toContain('Settings');
    expect(findAll(root, (e) => e.tagName === 'select' && e.id === 'dispatch-script')).toHaveLength(0);
  });

  it('shows and wires every button when all callbacks exist', () => {
    const log = newLog();
    const m = new MainMenu(fakeUi() as unknown as UIRoot, full(log));
    const root = m.element as unknown as FakeElement;
    const headings = findAll(root, (e) => e.tagName === 'h2').map((h) => h.textContent);
    expect(headings).toEqual(['Setup', 'Career', 'Free patrol', 'Training', 'Multiplayer (optional)', 'Mods', 'Continue']);
    m.seed = '3';
    findButton(root, 'New career').click();
    findButton(root, 'Academy drills').click();
    findButton(root, 'Report writing').click();
    findButton(root, 'Driving academy').click();
    findButton(root, 'Scenario editor').click();
    findButton(root, 'Co-op lobby…').click();
    findButton(root, 'Manage mods…').click();
    expect(log.career).toEqual([[3, 'generic']]);
    expect(log.training.map((t) => t[0])).toEqual(['drills', 'report', 'driving', 'sandbox']);
    expect(log.coop).toBe(1);
    expect(log.mods).toBe(1);
    expect(root.textContent).toContain('2 mods active');
  });

  it('the dispatch script select lists "no script" and the scripts, and its choice is passed on', () => {
    const log = newLog();
    const m = new MainMenu(fakeUi() as unknown as UIRoot, full(log));
    const root = m.element as unknown as FakeElement;
    const select = findAll(root, (e) => e.tagName === 'select' && e.id === 'dispatch-script')[0];
    if (!select) throw new Error('no script select');
    const options = findAll(select, (e) => e.tagName === 'option');
    expect(options.map((o) => o.textContent)).toEqual([NO_SCRIPT_LABEL, 'Friday night', 'Quiet weekday']);
    findButton(root, 'Dispatch-only').click();
    select.value = 'quiet-weekday';
    select.fire('change');
    findButton(root, 'Dispatch-only').click();
    expect(log.training).toEqual([['dispatch', undefined], ['dispatch', 'quiet-weekday']]);
  });

  it('re-reads the script list and the mod summary when the menu opens', () => {
    const log = newLog();
    let scripts = [{ id: 'a-script', name: 'A script' }];
    let summary = '0 mods active';
    const m = new MainMenu(fakeUi() as unknown as UIRoot, { ...full(log), scripts: () => scripts, modSummary: () => summary });
    const root = m.element as unknown as FakeElement;
    const select = findAll(root, (e) => e.tagName === 'select' && e.id === 'dispatch-script')[0] as FakeElement;
    expect(findAll(select, (e) => e.tagName === 'option')).toHaveLength(2);
    scripts = [...scripts, { id: 'b-script', name: 'B script' }];
    summary = '1 mod active';
    m.open();
    expect(findAll(select, (e) => e.tagName === 'option')).toHaveLength(3);
    expect(root.textContent).toContain('1 mod active');
  });

  it('keeps New game as the focused primary button and Enter in the seed box starting a free patrol', () => {
    const seen: unknown[][] = [];
    const m = new MainMenu(fakeUi() as unknown as UIRoot, { ...full(newLog()), newGame: (...a) => void seen.push(a) });
    const root = m.element as unknown as FakeElement;
    const primary = findButton(root, 'New game');
    expect(primary.attrs['autofocus']).toBeDefined();
    m.seed = '9';
    const input = findAll(root, (e) => e.id === 'seed')[0];
    input?.fire('keydown', { key: 'Enter' });
    expect(seen).toEqual([[9, 'generic']]);
  });
});
